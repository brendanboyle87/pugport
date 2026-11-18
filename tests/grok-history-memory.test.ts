import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { grokSyncByteBudget, syncGrokHistory } from '../src/server/grok-history-sync.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';

test('300 MiB synthetic sessions stream within a heap bound, defer durably, skip oversize, and never reread unchanged bytes', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pugport-grok-pressure-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const store = new WorkspaceStore(db);
  const data = join(root, 'data'),
    home = join(root, 'native'),
    projectPath = join(root, 'project');
  fs.mkdirSync(data);
  fs.mkdirSync(projectPath);
  store.save('project', 'synthetic', 'synthetic', {
    id: 'synthetic',
    name: 'Synthetic',
    path: projectPath,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
  const rawFiles: string[] = [];
  const chats: string[] = [];
  t.after(() => {
    db.close();
    const rel = relative(tmpdir(), root);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let n = 1; n <= 3; n++) {
    const id = `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
    const folder = join(home, 'sessions', encodeURIComponent(projectPath), id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      join(folder, 'summary.json'),
      JSON.stringify({ info: { cwd: projectPath }, created_at: `2026-01-0${n}`, updated_at: `2026-01-0${n}` }),
    );
    const chat = join(folder, 'chat_history.jsonl'),
      events = join(folder, 'events.jsonl');
    fs.writeFileSync(chat, JSON.stringify({ type: 'user', content: `Synthetic session ${n}` }) + '\n');
    // Every line is valid JSON; excluded native synthetic records must not become user messages.
    const prefix = '{"synthetic_reason":"fixture","content":"';
    const line = prefix + 'x'.repeat(4096 - prefix.length - 3) + '"}\n';
    assert.equal(Buffer.byteLength(line), 4096);
    const chunk = Buffer.from(line.repeat(256));
    const chatFd = fs.openSync(chat, 'a'),
      eventsFd = fs.openSync(events, 'w');
    try {
      for (let i = 0; i < 50; i++) {
        fs.writeSync(chatFd, chunk);
        fs.writeSync(eventsFd, chunk);
      }
    } finally {
      fs.closeSync(chatFd);
      fs.closeSync(eventsFd);
    }
    rawFiles.push(chat, events);
    chats.push(chat);
  }
  global.gc?.();
  const baselineStart = process.memoryUsage();
  // Reproduce the former capture representation: all session Buffers plus one decoded/split chat.
  let captured: Buffer[] | undefined = rawFiles.map((path) => fs.readFileSync(path));
  let decoded: string[] | undefined = captured[0]!.toString('utf8').split('\n');
  assert.ok(decoded.length > 10000);
  const baseline = process.memoryUsage();
  captured = undefined;
  decoded = undefined;
  global.gc?.();
  global.gc?.();
  const start = process.memoryUsage();
  let heapPeak = start.heapUsed,
    externalPeak = start.external,
    rssPeak = start.rss;
  const measure = () => {
    const usage = process.memoryUsage();
    heapPeak = Math.max(heapPeak, usage.heapUsed);
    externalPeak = Math.max(externalPeak, usage.external);
    rssPeak = Math.max(rssPeak, usage.rss);
  };
  const read = fs.readSync;
  const mocked = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    measure();
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const first = syncGrokHistory(store, data, 'synthetic', { grokHomes: [home] });
  measure();
  assert.equal(first.addedMessages, 2);
  assert.equal(first.deferredSessions, 1);
  assert.ok(first.sourceBytes! <= grokSyncByteBudget);
  // Reopen the store to prove progress is persisted rather than remembered in a process-local queue.
  const reopened = new WorkspaceStore(db);
  const second = syncGrokHistory(reopened, data, 'synthetic', { grokHomes: [home] });
  measure();
  assert.equal(second.addedMessages, 1);
  assert.equal(second.deferredSessions, 0);
  assert.equal(second.retainedMessages, 3);
  assert.ok(second.sourceBytes! < 101 * 1024 ** 2);
  const third = syncGrokHistory(reopened, data, 'synthetic', { grokHomes: [home] });
  assert.equal(third.sourceBytes, 0);
  assert.equal(third.addedMessages, 0);
  const oversized = join(home, 'sessions', encodeURIComponent(projectPath), '44444444-1111-4111-8111-111111111111');
  fs.mkdirSync(oversized);
  fs.writeFileSync(join(oversized, 'summary.json'), JSON.stringify({ info: { cwd: projectPath } }));
  const fd = fs.openSync(join(oversized, 'chat_history.jsonl'), 'w');
  fs.ftruncateSync(fd, 129 * 1024 ** 2);
  fs.closeSync(fd);
  const skipped = syncGrokHistory(reopened, data, 'synthetic', { grokHomes: [home] });
  assert.equal(skipped.skippedSessions, 1);
  assert.equal(skipped.retainedMessages, 3);
  assert.ok(skipped.warnings.some((reason) => reason.includes('oversized-file')));
  assert.equal(skipped.sourceBytes, 0);
  const hugeSession = join(home, 'sessions', encodeURIComponent(projectPath), '55555555-1111-4111-8111-111111111111');
  fs.mkdirSync(hugeSession);
  fs.writeFileSync(join(hugeSession, 'summary.json'), JSON.stringify({ info: { cwd: projectPath } }));
  for (const name of ['chat_history.jsonl', 'events.jsonl', 'updates.jsonl']) {
    const large = fs.openSync(join(hugeSession, name), 'w');
    fs.ftruncateSync(large, 90 * 1024 ** 2);
    fs.closeSync(large);
  }
  const oversizedSession = syncGrokHistory(reopened, data, 'synthetic', { grokHomes: [home] });
  assert.equal(oversizedSession.skippedSessions, 2);
  assert.ok(oversizedSession.warnings.some((reason) => reason.includes('oversized-session')));
  assert.equal(oversizedSession.retainedMessages, 3);
  assert.ok(heapPeak - start.heapUsed < 80 * 1024 ** 2, `peak heap growth ${heapPeak - start.heapUsed}`);
  assert.ok(externalPeak - start.external < 16 * 1024 ** 2, `peak external growth ${externalPeak - start.external}`);
  t.diagnostic(
    JSON.stringify({
      fixtureMiB: 300,
      baselineHeapMiB: (baseline.heapUsed - baselineStart.heapUsed) / 1024 ** 2,
      baselineExternalMiB: (baseline.external - baselineStart.external) / 1024 ** 2,
      newPeakHeapMiB: (heapPeak - start.heapUsed) / 1024 ** 2,
      newPeakExternalMiB: (externalPeak - start.external) / 1024 ** 2,
      newPeakRssMiB: (rssPeak - start.rss) / 1024 ** 2,
      firstPassMessages: first.addedMessages,
      secondPassMessages: second.addedMessages,
    }),
  );
});
