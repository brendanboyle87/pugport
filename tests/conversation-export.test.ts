import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { conversationExportRoutes } from '../src/server/conversation-export.ts';
import { messageAuthor } from '../src/server/message-author.ts';
import { providerNames } from '../src/shared/delegation.ts';
import type { ConversationMessage } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

async function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const stamp = '2026-01-01T12:00:00Z';
  store.save('project', 'p', '', { id: 'p', name: '示例项目', path: 'PRIVATE-PATH' });
  const conversation = (title = '中文对话', extra = {}) =>
    store.save('conversation', 'c', 'p', {
      id: 'c',
      projectId: 'p',
      title,
      createdAt: stamp,
      updatedAt: stamp,
      connectorIds: ['PRIVATE-CONNECTOR'],
      ...extra,
    });
  conversation();
  const message = (id: string, content: string, day: number, extra = {}) =>
    store.save('message', id, 'c', {
      id,
      conversationId: 'c',
      role: 'assistant',
      content,
      createdAt: `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`,
      ...extra,
    });
  const app = express();
  conversationExportRoutes(app, store, (id) => (id === 'known' ? providerNames.codex : undefined));
  const server = await listenForFetch(app);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
  });
  const { port } = server.address() as { port: number };
  const get = (query = '?format=md', id = 'c') =>
    fetch(`http://127.0.0.1:${port}/api/conversations/${id}/export${query}`);
  return { store, stamp, conversation, message, get };
}

test('Markdown exports all visible messages in order, authors, quotes and attachment metadata', async (t) => {
  const f = await fixture(t);
  f.message('last', 'Final reply', 5, { replyIdentity: { runs: [{ runtimeId: 'known', model: 'test-model' }] } });
  f.message('hidden', 'Hidden draft', 2, { replacedBy: 'last' });
  f.message('first', 'First question', 1, {
    role: 'user',
    quotes: [{ text: 'quoted\r\nsecond line', note: 'Keep this note' }],
    attachments: [
      { id: 'PRIVATE-ATTACHMENT', name: '资料.txt', size: 42, mimeType: 'text/plain', bytes: 'PRIVATE-BYTES' },
    ],
  });
  f.message('external', 'Web reply', 3, { externalAgent: { name: 'Muse' } });
  f.message('device', 'Device reply', 4, {
    device: { id: 'PRIVATE-DEVICE', name: 'PRIVATE-NAME', executor: 'Claude' },
  });
  f.message('fallback', 'System reply', 6);
  const response = await f.get();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['content', 'fileName', 'mimeType']);
  assert.equal(result.mimeType, 'text/markdown');
  const localStamp = new Date(f.stamp).toLocaleString();
  assert.ok(result.content.startsWith(`# 中文对话\n\n示例项目 · ${localStamp} · ${localStamp}`));
  const authors = [...result.content.matchAll(/^### (.+) · .+$/gm)].map((match) => match[1]);
  assert.deepEqual(authors, ['user', 'Muse', 'Claude', 'Codex · test-model', 'PugPort']);
  assert.ok(result.content.includes(`### user · ${new Date(f.stamp).toLocaleString()}`));
  const texts = ['First question', 'Web reply', 'Device reply', 'Final reply', 'System reply'];
  assert.deepEqual(
    [...texts].sort((a, b) => result.content.indexOf(a) - result.content.indexOf(b)),
    texts,
  );
  assert.match(result.content, /> quoted\n> second line\n\nKeep this note/);
  assert.match(result.content, /- 资料.txt \(42 B\)/);
  assert.doesNotMatch(result.content, /Hidden draft|PRIVATE/);
});

test('JSON uses an explicit whitelist, including nested metadata, with no private identity', async (t) => {
  const f = await fixture(t);
  f.message('m', 'Answer', 1, {
    clientMessageId: 'PRIVATE-CLIENT',
    importedFrom: { sessionId: 'PRIVATE-SESSION' },
    workflowId: 'PRIVATE-WORKFLOW',
    replyIdentity: { runs: [{ runtimeId: 'PRIVATE-RUNTIME', accountLabel: 'PRIVATE-ACCOUNT', model: 'test-model' }] },
    quotes: [{ text: 'quote', note: 'note', messageId: 'source', clientId: 'PRIVATE-QUOTE' }],
    attachments: [
      { name: 'file.txt', size: 0, mimeType: 'text/plain', id: 'PRIVATE-ATTACHMENT', bytes: 'PRIVATE-BYTES' },
    ],
  });
  f.message('hidden', 'Hidden', 2, { replacedBy: 'm' });
  const response = await f.get('?format=json');
  const result = await response.json();
  assert.equal(result.mimeType, 'application/json');
  assert.doesNotMatch(result.content, /PRIVATE|Hidden/);
  const data = JSON.parse(result.content);
  assert.deepEqual(Object.keys(data).sort(), ['app', 'conversation', 'exportedAt', 'messages', 'version']);
  assert.equal(data.app, 'PugPort');
  assert.equal(data.version, 1);
  assert.ok(Number.isFinite(Date.parse(data.exportedAt)));
  assert.deepEqual(data.conversation, {
    id: 'c',
    title: '中文对话',
    project: '示例项目',
    createdAt: f.stamp,
    updatedAt: f.stamp,
  });
  assert.deepEqual(data.messages, [
    {
      id: 'm',
      role: 'assistant',
      author: 'PugPort · test-model',
      createdAt: f.stamp,
      content: 'Answer',
      quotes: [{ text: 'quote', note: 'note', messageId: 'source' }],
      attachments: [{ name: 'file.txt', size: 0, mimeType: 'text/plain' }],
    },
  ]);
});

test('JSON retains the complete markup contract and Markdown retains notes and geometry', async (t) => {
  const f = await fixture(t);
  const markup = {
    version: 1,
    source: { kind: 'image', name: 'photo.jpg', width: 800, height: 600 },
    attachment: 'photo-标注.png',
    marks: [{ n: 1, kind: 'rect', color: '#e5322d', box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }, note: '改成蓝色' }],
    crops: [{ n: 1, attachmentId: 'crop-id', name: 'photo-标注-1.jpg' }],
  };
  f.message('m', 'Modify', 1, { quotes: [{ text: '标记 1（方框，红色）', note: '标记 1：改成蓝色', markup }] });
  const json = await (await f.get('?format=json')).json();
  const { crops: _crops, ...exported } = markup;
  assert.deepEqual(JSON.parse(json.content).messages[0].quotes[0].markup, exported);
  const markdown = await (await f.get()).json();
  assert.match(markdown.content, /> 标记 1（方框，红色）/);
  assert.match(markdown.content, /标记 1：改成蓝色/);
});

test('chat-scope exports omit the internal project name and system notices in both formats', async (t) => {
  const f = await fixture(t);
  f.store.save('project', 'p', '', { id: 'p', name: '日常对话', scope: 'chat' });
  f.message('notice', '本轮已停止', 1, { systemNotice: { text: '本轮已停止' } });
  f.message('reply', 'Visible answer', 2);
  const markdown = (await (await f.get()).json()).content;
  const localStamp = new Date(f.stamp).toLocaleString();
  assert.ok(markdown.startsWith(`# 中文对话\n\n${localStamp} · ${localStamp}\n\n###`));
  assert.doesNotMatch(markdown, /日常对话|本轮已停止/);
  const json = (await (await f.get('?format=json')).json()).content;
  assert.doesNotMatch(json, /日常对话|本轮已停止/);
  const data = JSON.parse(json);
  assert.equal(data.conversation.project, '');
  assert.deepEqual(
    data.messages.map((message: ConversationMessage) => message.id),
    ['reply'],
  );
});

test('file dates and Markdown timestamps use local time across a UTC date boundary', async (t) => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
  const now = new Date('2026-01-02T01:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = await fixture(t);
  f.conversation('Local date', { createdAt: now.toISOString(), updatedAt: now.toISOString() });
  f.message('reply', 'Answer', 2, { createdAt: now.toISOString() });
  const markdown = await (await f.get()).json();
  assert.equal(markdown.fileName, 'Local date-2026-01-01.md');
  const localStamp = now.toLocaleString();
  assert.ok(markdown.content.startsWith(`# Local date\n\n示例项目 · ${localStamp} · ${localStamp}`));
  assert.ok(markdown.content.includes(`### PugPort · ${localStamp}`));
  const json = await (await f.get('?format=json')).json();
  assert.equal(json.fileName, 'Local date-2026-01-01.json');
  assert.equal(JSON.parse(json.content).exportedAt, now.toISOString());
});

test('Markdown closes incomplete code fences before quotes, attachments and later message headings', async (t) => {
  const f = await fixture(t);
  const incomplete = 'Example\r\n```ts\r\nconst answer = 42;';
  f.message('open', incomplete, 1, {
    quotes: [{ text: 'Quote after code' }],
    attachments: [{ name: 'file.txt', size: 1 }],
  });
  const complete = '```text\nComplete\n```';
  f.message('closed', complete, 2);
  f.message('plain', 'Later answer', 3);
  const markdown = (await (await f.get()).json()).content;
  assert.ok(markdown.includes(`${incomplete}\n\`\`\`\n\n> Quote after code\n\n- file.txt (1 B)\n\n###`));
  assert.ok(markdown.includes(`${complete}\n\n###`));
  assert.equal((markdown.match(/^```/gm) ?? []).length, 4);
  const data = JSON.parse((await (await f.get('?format=json')).json()).content);
  assert.deepEqual(
    data.messages.map((message: ConversationMessage) => message.content),
    [incomplete, complete, 'Later answer'],
  );
});

test('exports empty conversations; deleted/missing conversations return 404; invalid formats return 400', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse((await (await f.get('?format=json')).json()).content).messages, []);
  for (const query of ['', '?format=xml', '?format=md&format=json']) assert.equal((await f.get(query)).status, 400);
  f.conversation('Deleted', { deletedAt: f.stamp });
  for (const format of ['md', 'json']) {
    assert.equal((await f.get(`?format=${format}`)).status, 404);
    assert.equal((await f.get(`?format=${format}`, 'missing')).status, 404);
  }
});

test('file names retain Chinese and dates, strip forbidden characters, avoid reserved names and cap length', async (t) => {
  const f = await fixture(t);
  for (const [title, prefix] of [
    ['中文标题', '中文标题'],
    ['中/\\:*?"<>|\u0000\u001f\u007f文. ', '中文'],
    ['CON', '_CON'],
    ['CON .txt', '_CON .txt'],
    ['nul.txt', '_nul.txt'],
    ['COM1', '_COM1'],
    ['LPT9', '_LPT9'],
    ['Aux', '_Aux'],
    ['PRN', '_PRN'],
    ['COM¹', '_COM¹'],
    ['... ', 'conversation'],
    ['x'.repeat(200), 'x'.repeat(69)],
    ['😀'.repeat(100), '😀'.repeat(34)],
    ['x'.repeat(68) + '😀tail', 'x'.repeat(68)],
  ]) {
    f.conversation(title);
    for (const format of ['md', 'json']) {
      const { fileName } = await (await f.get(`?format=${format}`)).json();
      assert.match(fileName, new RegExp(`-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
      assert.equal(fileName.slice(0, -11 - format.length - 1), prefix);
      assert.ok(fileName.length - format.length - 1 <= 80);
      assert.doesNotMatch(fileName, /[\/\\:*?"<>|\u0000-\u001f\u007f]/);
    }
  }
});

test('shared author function preserves external read labels and last-run precedence', () => {
  const message = {
    role: 'assistant',
    replyIdentity: {
      runs: [
        { runtimeId: 'old', model: 'old' },
        { runtimeId: 'new', accountLabel: 'Account', model: 'model' },
      ],
    },
  } as ConversationMessage;
  assert.equal(
    messageAuthor(message, () => 'Label'),
    'Label · model',
  );
  assert.equal(
    messageAuthor(message, () => undefined),
    'Account · model',
  );
  assert.equal(
    messageAuthor({ ...message, device: { id: 'd', name: 'Laptop', executor: 'Codex' } }, () => undefined),
    'Laptop · Codex',
  );
  assert.equal(
    messageAuthor({ ...message, role: 'user' }, () => 'Label'),
    'user',
  );
  const unnamedDevice = { ...message, device: { id: 'd', name: '' } };
  assert.equal(
    messageAuthor(unnamedDevice, () => undefined),
    '',
  );
  assert.equal(
    messageAuthor(unnamedDevice, () => undefined, false),
    'PugPort',
  );
});
