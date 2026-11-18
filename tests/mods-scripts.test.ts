import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packMod } from '../scripts/pack-mod.ts';
import { validateModFile } from '../scripts/validate-mod.ts';

const example = 'docs/examples/mods/reading-notes';
const minimal = { schemaVersion: 2, id: 'test.notes', version: '1.0.0', title: 'Notes', description: 'Test notes' };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mods-scripts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('validator accepts the unchanged v1 example', async () => {
  const result = await validateModFile('docs/examples/mod-manifest.example.json');
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.equal(result.manifest?.schemaVersion, 1);
  assert.equal(result.sha256.length, 64);
});

test('validator reports field paths for broken manifests and parse errors', async (t) => {
  const dir = await fixture(t);
  const path = join(dir, 'broken.json');
  await writeFile(path, JSON.stringify({ ...minimal, title: '' }));
  const result = await validateModFile(path);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /title:/);
  await writeFile(path, '{');
  assert.equal((await validateModFile(path)).ok, false);
});

test('packer and validator preserve card art and reject invalid dimensions or missing alt', async (t) => {
  const dir = await fixture(t);
  const source = join(dir, 'manifest.json');
  const out = join(dir, 'packed.json');
  const image = Buffer.from(
    'UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAEAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==',
    'base64',
  );
  image.writeUInt16LE(640, 26);
  image.writeUInt16LE(480, 28);
  const card = { src: `data:image/webp;base64,${image.toString('base64')}`, alt: 'Synthetic card' };
  await writeFile(source, JSON.stringify({ ...minimal, card }));
  const packed = await packMod(dir, { out });
  const validated = await validateModFile(out);
  assert.equal(validated.ok, true, validated.issues.join('\n'));
  assert.equal(packed.manifest.schemaVersion, 2);
  if (packed.manifest.schemaVersion === 2) assert.deepEqual(packed.manifest.card, card);
  image.writeUInt16LE(360, 28);
  for (const invalid of [{ src: card.src }, { ...card, src: `data:image/webp;base64,${image.toString('base64')}` }]) {
    await writeFile(source, JSON.stringify({ ...minimal, card: invalid }));
    await assert.rejects(packMod(dir, { out }), /card\./);
    const result = await validateModFile(source);
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /card\./);
  }
});

test('inline event handlers warn without failing validation', async (t) => {
  const dir = await fixture(t);
  const path = join(dir, 'events.json');
  await writeFile(
    path,
    JSON.stringify({ ...minimal, ui: { entries: { panel: { html: '<button onclick="alert(1)">Go</button>' } } } }),
  );
  const result = await validateModFile(path);
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.match(result.warnings[0], /warn: ui.entries.panel.html: inline event handler/);
});

test('validator refuses oversized and nonregular inputs before parsing', async (t) => {
  const dir = await fixture(t);
  const path = join(dir, 'large.json');
  await writeFile(path, '');
  await truncate(path, 1024 * 1024 + 1);
  assert.deepEqual((await validateModFile(path)).issues, ['file is larger than 1 MiB']);
  assert.match((await validateModFile(dir)).issues.join('\n'), /regular file/);
});

test('packer inlines reading-notes entries and README and hashes exact output bytes', async (t) => {
  const dir = await fixture(t);
  await cp(example, dir, { recursive: true });
  const result = await packMod(dir, { out: join(dir, 'output', 'notes.json') });
  const validated = await validateModFile(result.path);
  assert.equal(validated.ok, true, validated.issues.join('\n'));
  assert.equal(result.manifest.schemaVersion, 2);
  if (result.manifest.schemaVersion !== 2) return;
  for (const kind of ['html', 'css', 'js'] as const) {
    assert.equal(result.manifest.ui?.entries.main[kind], await readFile(join(dir, 'ui', `main.${kind}`), 'utf8'));
  }
  assert.equal(result.manifest.readme, await readFile(join(dir, 'README.md'), 'utf8'));
  const written = await readFile(result.path);
  assert.equal(written.length, result.bytes);
  assert.equal(createHash('sha256').update(written).digest('hex'), result.sha256);
  assert.equal(validated.sha256, result.sha256);
  assert.equal(written.toString(), `${JSON.stringify(result.manifest, null, 2)}\n`);
});

test('dev packing bumps a valid source patch and follows it in the default output name', async (t) => {
  const dir = await fixture(t);
  const source = join(dir, 'manifest.json');
  const id = `test.notes-${Date.now()}`;
  await writeFile(source, JSON.stringify({ ...minimal, id }));
  const result = await packMod(dir, { dev: true });
  t.after(() => rm(result.path, { force: true }));
  assert.equal(JSON.parse(await readFile(source, 'utf8')).version, '1.0.1');
  assert.equal(result.manifest.version, '1.0.1');
  assert.ok(result.path.endsWith(`${id}-1.0.1.json`));
});

test('packer refuses inline ui and never bumps invalid sources or writes output', async (t) => {
  const dir = await fixture(t);
  const source = join(dir, 'manifest.json');
  const content = JSON.stringify({ ...minimal, ui: {} });
  const out = join(dir, 'out.json');
  await writeFile(source, content);
  await assert.rejects(packMod(dir, { dev: true, out }), /must not contain ui/);
  assert.equal(await readFile(source, 'utf8'), content);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
  await writeFile(source, JSON.stringify({ ...minimal, title: '' }));
  await assert.rejects(packMod(dir, { dev: true, out }), /title:/);
  assert.equal(JSON.parse(await readFile(source, 'utf8')).version, '1.0.0');
  await assert.rejects(lstat(out), { code: 'ENOENT' });
});

test('packer rejects unknown, oversized and nonregular entry files', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(minimal));
  await mkdir(join(dir, 'ui'));
  const unknown = join(dir, 'ui', 'notes.txt');
  await writeFile(unknown, 'unknown');
  await assert.rejects(packMod(dir), /unknown file name/);
  await rm(unknown);
  const html = join(dir, 'ui', 'panel.html');
  await writeFile(html, 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(packMod(dir), /file exceeds 131072 bytes/);
  await rm(html);
  await mkdir(html);
  await assert.rejects(packMod(dir), /regular file/);
});

test('packer respects explicit readme and rejects oversized README before reads', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...minimal, readme: 'Manifest readme' }));
  await writeFile(join(dir, 'README.md'), 'File readme');
  const result = await packMod(dir, { out: join(dir, 'out.json') });
  assert.equal(result.manifest.readme, 'Manifest readme');
  await writeFile(join(dir, 'README.md'), 'x'.repeat(20001));
  await assert.rejects(packMod(dir), /file exceeds 20000 bytes/);
});

test('packer handles a constructor entry as an own key', async (t) => {
  const dir = await fixture(t);
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...minimal, contributions: { rightPanel: { kind: 'web', entry: 'constructor' } } }),
  );
  await mkdir(join(dir, 'ui'));
  await writeFile(join(dir, 'ui', 'constructor.html'), '<p>Notes</p>');
  const result = await packMod(dir, { out: join(dir, 'out.json') });
  assert.equal(result.manifest.schemaVersion, 2);
  if (result.manifest.schemaVersion === 2)
    assert.equal(result.manifest.ui?.entries['constructor'].html, '<p>Notes</p>');
});

test('packer checks the formatted output budget before writing or bumping', async (t) => {
  const dir = await fixture(t);
  const source = JSON.stringify(minimal);
  await writeFile(join(dir, 'manifest.json'), source);
  await mkdir(join(dir, 'ui'));
  const entries: Record<string, { html: string; js: string }> = Object.fromEntries(
    ['one', 'two', 'three', 'four'].map((key, index) => [
      key,
      { html: '', js: index < 3 ? 'x'.repeat(256 * 1024) : '' },
    ]),
  );
  const overhead = Buffer.byteLength(JSON.stringify({ ...minimal, ui: { entries } }));
  entries.four.js = 'x'.repeat(1024 * 1024 - overhead - 1);
  for (const [key, entry] of Object.entries(entries)) {
    await writeFile(join(dir, 'ui', `${key}.html`), entry.html);
    await writeFile(join(dir, 'ui', `${key}.js`), entry.js);
  }
  const out = join(dir, 'out.json');
  await assert.rejects(packMod(dir, { dev: true, out }), /formatted file is larger than 1 MiB/);
  assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8'), source);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
});

type NotesElement = {
  value: string;
  textContent: string;
  disabled: boolean;
  hidden: boolean;
  focus(): void;
  listeners: Record<string, () => void>;
  addEventListener(name: string, listener: () => void): void;
};

async function notesRuntime(failFirstLoad = false) {
  const { runInNewContext } = await import('node:vm');
  const elements = Object.fromEntries(
    ['title', 'notes', 'status', 'retry', 'quote', 'discuss'].map((id) => [
      id,
      {
        value: '',
        textContent: '',
        disabled: true,
        hidden: false,
        listeners: {},
        focus() {},
        addEventListener(this: NotesElement, name: string, listener: () => void) {
          this.listeners[name] = listener;
        },
      },
    ]),
  ) as Record<string, NotesElement>;
  const events: Record<string, (data: unknown) => void> = {};
  const documentEvents: Record<string, (event: { key: string; ctrlKey: boolean; preventDefault(): void }) => void> = {};
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const fixture = {
    state: { revision: 0, values: { title: '', notes: 'saved notes' } },
    dirty: [] as boolean[],
    chat: [] as boolean[],
    tokens: {} as Record<string, string>,
    drafts: [] as { text: string; mode: string }[],
    writes: [] as { values: { title: string; notes: string }; expectedRevision: number }[],
    messages: [{ id: 'm', role: 'user', content: '<b>message stays text</b>', createdAt: '2026-10-29' }],
    waitForWrite: undefined as undefined | Promise<void>,
    waitForMessages: undefined as undefined | Promise<void>,
    waitForInsert: undefined as undefined | Promise<void>,
    failWrite: false,
  };
  const api = {
    host: { info: async () => ({ theme: 'dark', tokens: { '--text': '#eee' }, layout: 'workspace' }) },
    state: {
      get: async () => {
        if (failFirstLoad) {
          failFirstLoad = false;
          throw new Error('Synthetic unavailable state');
        }
        return structuredClone(fixture.state);
      },
      set: async (input: { values: { title: string; notes: string }; expectedRevision: number }) => {
        fixture.writes.push(input);
        if (fixture.waitForWrite) await fixture.waitForWrite;
        if (fixture.failWrite) throw new Error('Synthetic save failure');
        if (input.expectedRevision !== fixture.state.revision)
          throw Object.assign(new Error('State revision changed.'), { code: 'E_CONFLICT' });
        fixture.state = { revision: fixture.state.revision + 1, values: { ...fixture.state.values, ...input.values } };
        return structuredClone(fixture.state);
      },
    },
    messages: {
      list: async () => {
        if (fixture.waitForMessages) await fixture.waitForMessages;
        return fixture.messages;
      },
    },
    composer: {
      insert: async (input: { text: string; mode: string }) => {
        fixture.drafts.push(input);
        if (fixture.waitForInsert) await fixture.waitForInsert;
        return {};
      },
    },
    ui: {
      chat: async ({ open }: { open: boolean }) => {
        fixture.chat.push(open);
        return {};
      },
      setDirty: async (dirty: boolean) => {
        fixture.dirty.push(dirty);
        return {};
      },
    },
    on: (name: string, handler: (data: unknown) => void) => {
      events[name] = handler;
      return () => delete events[name];
    },
  };
  const style = {
    colorScheme: '',
    setProperty: (key: string, value: string) => {
      fixture.tokens[key] = value;
    },
  };
  runInNewContext(await readFile(join(example, 'ui/main.js'), 'utf8'), {
    window: { pugport: api },
    document: {
      getElementById: (id: string) => elements[id],
      documentElement: { style },
      addEventListener: (name: string, handler: (typeof documentEvents)[string]) => {
        documentEvents[name] = handler;
      },
    },
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, 800);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (timer: number) => timers.delete(timer),
  });
  const settle = async () => {
    for (let n = 0; n < 4; n++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await settle();
  return {
    fixture,
    elements,
    events,
    settle,
    style,
    timers,
    edit(text: string, field = 'notes') {
      elements[field].value = text;
      elements[field].listeners.input();
    },
    click(id: string) {
      elements[id].listeners.click();
    },
    saveNow() {
      documentEvents.keydown({ key: 's', ctrlKey: true, preventDefault() {} });
    },
    autosave() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

test('reading-notes saves title and notes before preparing a draft, and disables detached controls', async () => {
  const f = await notesRuntime();
  assert.equal(f.elements.notes.value, 'saved notes');
  assert.equal(f.elements.notes.disabled, false);
  f.edit('my notes');
  f.edit('A book', 'title');
  assert.equal(f.fixture.dirty.at(-1), true);
  f.click('discuss');
  await f.settle();
  assert.equal(f.fixture.writes[0].expectedRevision, 0);
  assert.equal(f.fixture.state.values.notes, 'my notes');
  assert.equal(f.fixture.state.values.title, 'A book');
  assert.equal(f.fixture.drafts[0].mode, 'append');
  assert.equal(f.fixture.drafts[0].text, 'My notes on "A book":\n\nmy notes');
  assert.equal(f.fixture.dirty.at(-1), false);
  assert.equal(f.elements.status.textContent, 'Added to your message. Review it, then send.');
  f.events.detached({});
  for (const id of ['title', 'notes', 'quote', 'discuss']) assert.equal(f.elements[id].disabled, true);
  assert.equal(f.elements.status.textContent, 'This Mod was removed from the chat.');
});

test('reading-notes debounces autosave at 800 ms and clears feedback while typing', async () => {
  const f = await notesRuntime();
  f.edit('first');
  f.edit('latest');
  assert.equal(f.timers.size, 1);
  assert.equal(f.fixture.writes.length, 0);
  assert.equal(f.elements.status.textContent, '');
  f.autosave();
  await f.settle();
  assert.equal(f.fixture.state.values.notes, 'latest');
  assert.equal(f.elements.status.textContent, 'Saved');
  assert.equal(f.fixture.dirty.at(-1), false);
  f.edit('typing again');
  assert.equal(f.elements.status.textContent, '');
});

test('reading-notes pauses on conflicts and only Keep mine permits overwriting', async () => {
  const f = await notesRuntime();
  f.edit('local edits');
  f.fixture.state = { revision: 1, values: { title: '', notes: '<script>other window</script>' } };
  f.events.state(f.fixture.state);
  assert.equal(f.elements.notes.value, 'local edits');
  f.click('discuss');
  await f.settle();
  assert.equal(f.fixture.writes[0].expectedRevision, 0);
  assert.equal(f.elements.notes.value, 'local edits');
  assert.equal(f.fixture.drafts.length, 0);
  assert.equal(f.fixture.dirty.at(-1), true);
  assert.equal(f.elements.status.textContent, 'Also changed in another window.');
  assert.equal(f.elements.retry.textContent, 'Keep mine');
  f.saveNow();
  f.autosave();
  await f.settle();
  assert.equal(f.fixture.writes.length, 1);
  f.click('retry');
  await f.settle();
  assert.equal(f.fixture.writes[1].expectedRevision, 1);
  assert.equal(f.fixture.state.values.notes, 'local edits');
  assert.equal(f.fixture.drafts.length, 0);
  assert.equal(f.fixture.dirty.at(-1), false);
});

test('reading-notes retains newer dirty input when a pending save completes and reschedules', async () => {
  const f = await notesRuntime();
  let finish!: () => void;
  f.fixture.waitForWrite = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.edit('snapshot');
  f.saveNow();
  f.edit('newer input');
  finish();
  await f.settle();
  assert.equal(f.fixture.state.values.notes, 'snapshot');
  assert.equal(f.elements.notes.value, 'newer input');
  assert.equal(f.fixture.dirty.at(-1), true);
  assert.equal(f.elements.status.textContent, '');
  assert.equal(f.timers.size, 1);
  f.autosave();
  await f.settle();
  assert.equal(f.fixture.state.values.notes, 'newer input');
  assert.equal(f.fixture.dirty.at(-1), false);
});

test('reading-notes compares edits against the latest saved copy after a conflict', async () => {
  const f = await notesRuntime();
  f.edit('local edits');
  f.fixture.state = { revision: 1, values: { title: '', notes: 'saved in another window' } };
  f.saveNow();
  await f.settle();
  f.edit('saved notes');
  assert.equal(f.fixture.dirty.at(-1), true);
  f.events.state(f.fixture.state);
  assert.equal(f.elements.notes.value, 'saved notes');
  f.edit('saved in another window');
  assert.equal(f.fixture.dirty.at(-1), false);
});

test('reading-notes opens chat when no reply exists and follows theme tokens', async () => {
  const f = await notesRuntime();
  assert.equal(f.fixture.tokens['--text'], '#eee');
  assert.equal(f.style.colorScheme, 'dark');
  f.click('quote');
  await f.settle();
  assert.deepEqual(f.fixture.chat, [true]);
  assert.equal(f.elements.status.textContent, 'No reply yet. Ask something in the chat.');
  assert.equal(f.fixture.drafts.length, 0);
  f.events.theme({ theme: 'light', tokens: { '--text': '#111' } });
  assert.equal(f.fixture.tokens['--text'], '#111');
  assert.equal(f.style.colorScheme, 'light');
});

test('reading-notes quotes the latest assistant as plain text and autosaves it', async () => {
  const f = await notesRuntime();
  f.fixture.messages.push({
    id: 'reply',
    role: 'assistant',
    content: '<b>reply</b>\nsecond line',
    createdAt: '2026-10-29',
  });
  f.click('quote');
  await f.settle();
  assert.equal(f.elements.notes.value, 'saved notes\n\n> <b>reply</b>\n> second line\n');
  assert.equal(f.fixture.chat.length, 0);
  f.autosave();
  await f.settle();
  assert.equal(f.fixture.state.values.notes, f.elements.notes.value);
});

test('reading-notes retains text on failed save and retries without preparing an unsaved draft', async () => {
  const f = await notesRuntime();
  f.fixture.failWrite = true;
  f.edit('keep this');
  f.click('discuss');
  await f.settle();
  assert.equal(f.elements.notes.value, 'keep this');
  assert.equal(f.elements.status.textContent, "Couldn't save. Your text is still here.");
  assert.equal(f.elements.retry.textContent, 'Try again');
  assert.equal(f.fixture.drafts.length, 0);
  f.fixture.failWrite = false;
  f.click('retry');
  await f.settle();
  assert.equal(f.fixture.state.values.notes, 'keep this');
  assert.equal(f.fixture.dirty.at(-1), false);
});

test('reading-notes disables editing after failed load and retries without losing state', async () => {
  const f = await notesRuntime(true);
  assert.equal(f.elements.notes.disabled, true);
  assert.equal(f.elements.retry.hidden, false);
  assert.equal(f.elements.status.textContent, "Couldn't load your notes.");
  f.click('retry');
  await f.settle();
  assert.equal(f.elements.retry.hidden, true);
  assert.equal(f.elements.notes.disabled, false);
  assert.equal(f.elements.notes.value, 'saved notes');
  assert.equal(f.fixture.writes.length, 0);
});

test('reading-notes preserves detached feedback when a pending save returns', async () => {
  const f = await notesRuntime();
  let finish!: () => void;
  f.fixture.waitForWrite = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.edit('snapshot');
  f.click('discuss');
  f.events.detached({});
  finish();
  await f.settle();
  assert.equal(f.elements.status.textContent, 'This Mod was removed from the chat.');
  assert.equal(f.fixture.drafts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('reading-notes ignores a pending reply read after removal, including empty replies and failures', async () => {
  for (const outcome of ['reply', 'empty', 'failure']) {
    const f = await notesRuntime();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    f.fixture.waitForMessages = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    if (outcome === 'reply')
      f.fixture.messages.push({ id: 'reply', role: 'assistant', content: 'late reply', createdAt: '2026-10-29' });
    f.click('quote');
    f.events.detached({});
    if (outcome === 'failure') fail(new Error('Synthetic detached read'));
    else finish();
    await f.settle();
    assert.equal(f.elements.notes.value, 'saved notes', outcome);
    assert.equal(f.elements.status.textContent, 'This Mod was removed from the chat.', outcome);
    assert.deepEqual(f.fixture.chat, [], outcome);
    assert.equal(f.timers.size, 0, outcome);
  }
});

test('reading-notes preserves removal state across draft preparation and its late success or failure', async () => {
  const immediate = await notesRuntime();
  immediate.click('discuss');
  immediate.events.detached({});
  await immediate.settle();
  assert.equal(immediate.fixture.drafts.length, 0, 'removal before draft preparation prevents the call');
  for (const rejected of [false, true]) {
    const f = await notesRuntime();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    f.fixture.waitForInsert = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    f.click('discuss');
    await f.settle();
    assert.equal(f.fixture.drafts.length, 1);
    f.events.detached({});
    if (rejected) fail(new Error('Synthetic detached insert'));
    else finish();
    await f.settle();
    assert.equal(f.elements.status.textContent, 'This Mod was removed from the chat.');
    assert.equal(f.elements.discuss.disabled, true);
    assert.equal(f.elements.notes.value, 'saved notes');
  }
});

test('reading-notes ignores state and queued input events after removal', async () => {
  const f = await notesRuntime();
  f.events.detached({});
  f.events.state({ revision: 2, values: { title: 'late title', notes: 'late state' } });
  f.elements.notes.listeners.input();
  assert.equal(f.elements.title.value, '');
  assert.equal(f.elements.notes.value, 'saved notes');
  assert.equal(f.elements.status.textContent, 'This Mod was removed from the chat.');
  assert.equal(f.timers.size, 0);
});
