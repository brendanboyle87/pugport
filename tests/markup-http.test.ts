import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import type { Conversation, ConversationMessage, Project } from '../src/shared/types.ts';
import type { MessageMarkup } from '../src/shared/markup.ts';

test(
  'real main.ts route replaces client markup text and crops and reads canonical stored quotes',
  { timeout: 60000 },
  async (t) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-markup-http-')));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_STUDIO_PORT: '0',
      COMBORUNNER_ROOT: directory,
      COMBORUNNER_DATA_DIR: join(directory, 'data'),
      PUGPORT_ROLE: 'node',
      PUGPORT_NODE_FEATURES: '',
    };
    for (const name of [
      'COMBORUNNER_SECRETS_DIR',
      'COMBORUNNER_EXTENSIONS_DIR',
      'COMBORUNNER_MEMORY_DIR',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'CURSOR_CONFIG_DIR',
    ]) {
      env[name] = join(directory, name);
      mkdirSync(env[name]!, { recursive: true });
    }
    // Reuse the synthetic backend fixture: it disables discovery and extension launches before importing main.ts.
    const child = fork(resolve('tests/helpers/security-backend.ts'), [], {
      execPath: process.execPath,
      execArgv: process.execArgv,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let diagnostics = '',
      token = '',
      owner = '';
    child.stdout?.resume();
    child.stderr?.on('data', (data) => {
      diagnostics += String(data);
    });
    const exited = new Promise((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 10000);
      await exited;
      clearTimeout(timer);
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-markup-http-'));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const port = await new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code) => fail(Error(`backend exit ${code}: ${diagnostics}`)));
      child.on('message', (message: { type?: string; token?: string; owner?: string; port?: number }) => {
        if (message.type === 'session') {
          token = message.token!;
          owner = message.owner!;
        }
        if (message.type === 'ready') done(message.port!);
      });
    });
    const base = `http://127.0.0.1:${port}`,
      headers = { 'x-agent-token': token, 'x-pugport-owner': owner };
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await response.json();
      assert.ok(response.ok, JSON.stringify(json));
      return json;
    };
    const project = (await request('/api/projects', { path: directory })) as Project;
    const conversation = (await request('/api/conversations', {
      projectId: project.id,
      title: 'Synthetic markup',
    })) as Conversation;
    const url = `/api/conversations/${conversation.id}`;
    const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f0f3f8' } })
      .png()
      .toBuffer();
    const upload = await fetch(base + url + '/attachments', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'image/png', 'x-attachment-name': encodeURIComponent('photo-标注.png') },
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const attachment = (await upload.json()) as { id: string };
    const markup: MessageMarkup = {
      version: 1,
      source: { kind: 'image', name: 'photo.jpg', width: 800, height: 600 },
      attachment: 'photo-标注.png',
      marks: [
        { n: 1, kind: 'ellipse', color: '#e5322d', box: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }, note: '改成蓝色' },
      ],
      crops: [{ n: 1, attachmentId: 'forged-id', name: 'forged.jpg' }],
    };
    const sent = (await request(url + '/messages', {
      content: '按标注修改',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      autoEscalate: true,
      queue: true,
      attachmentIds: [attachment.id],
      quotes: [{ text: 'forged text', note: 'forged note', markup }],
    })) as { message: ConversationMessage };
    const loaded = (await request(url)) as { messages: ConversationMessage[] };
    const stored = loaded.messages.find((message) => message.id === sent.message.id)!;
    assert.equal(stored.attachments!.length, 1);
    const quote = stored.quotes![0]!;
    assert.match(quote.text, /图片标注：附件/);
    assert.match(quote.text, /标记 1（圆圈，红色）/);
    assert.match(quote.text, /局部放大图：photo-标注-1.jpg/);
    assert.equal(quote.note, '标记 1：改成蓝色');
    assert.equal(quote.markup!.crops!.length, 1);
    assert.notEqual(quote.markup!.crops![0]!.attachmentId, 'forged-id');
    assert.doesNotMatch(JSON.stringify(quote), /forged/);
  },
);
