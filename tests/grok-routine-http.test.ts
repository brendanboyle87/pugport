import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { fork } from '../src/server/platform/test-process.ts';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { grokReplyHash, grokReplyPath } from '../src/server/external-agents/grok-routine.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

test(
  'real HTTP guards, platform-native UTF-8 callbacks, BOM, multipart limits, expiry and unknown ids',
  { timeout: 45000 },
  async (t) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'grok-routine-http-')));
    const data = join(directory, 'data');
    const store = new Store(data);
    store.setConfig(
      'targets',
      (['codex', 'claude', 'grok', 'pi', 'cursor'] as const).map<RuntimeTarget>((provider) => ({
        id: `${provider}-native`,
        provider,
        label: 'Disabled fixture',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      })),
    );
    writeFileSync(
      join(data, 'external-agents.json'),
      JSON.stringify({ version: 1, agents: { 'grok-bot': { usageEnabled: false } } }),
    );
    const workspace = new WorkspaceStore(store.db);
    const ids = ['a', 'b', 'c'].map((c) => c.repeat(32));
    workspace.save('project', 'project', '', {
      id: 'project',
      name: 'Synthetic',
      path: directory,
      scope: 'chat',
      createdAt: new Date().toISOString(),
    });
    workspace.save('conversation', 'conversation', 'project', {
      id: 'conversation',
      projectId: 'project',
      title: 'Synthetic',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const messages = ids.map((id, i) => {
      const message = workspace.addMessage('conversation', 'assistant', 'waiting');
      message.externalAgent = {
        agentId: 'grok-bot',
        name: 'Grok Bot',
        status: i === 0 ? 'failed' : 'working',
        request: 'Synthetic task',
        updatedAt: new Date().toISOString(),
        routine: {
          replyHash: grokReplyHash(id),
          sentAt: new Date(Date.now() - (i === 2 ? 86_500_000 : 0)).toISOString(),
        },
      };
      workspace.save('message', message.id, 'conversation', message);
      return message.id;
    });
    store.close();
    const child = fork(resolve('src/server/main.ts'), [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        ...process.env,
        COMBORUNNER_ROOT: directory,
        COMBORUNNER_DATA_DIR: data,
        COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
        COMBORUNNER_SECRETS_DIR: join(directory, 'secrets'),
        COMBORUNNER_PORT: '0',
        USERPROFILE: directory,
        HOME: directory,
        CODEX_HOME: join(directory, 'codex'),
        APPDATA: join(directory, 'appdata'),
        LOCALAPPDATA: join(directory, 'localappdata'),
        JEV_API_KEY: '',
        TYPESAFE_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (b) => {
      output += b;
    });
    child.stderr?.on('data', (b) => {
      output += b;
    });
    const exited = new Promise((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('grok-routine-http-'));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error(output)));
      child.on('message', (m: { type?: string; token?: string; owner?: string; port?: number }) => {
        if (m.type === 'session') {
          token = m.token ?? '';
          owner = m.owner ?? '';
        }
        if (m.type === 'ready' && m.port) done(m.port);
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + grokReplyPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    assert.equal((await post({ replyId: ids[0], text: 'bad' }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await post('plain text', { 'content-type': 'text/plain' })).status, 415);
    for (const suffix of ['/', '/extra']) {
      assert.equal(
        (
          await fetch(base + grokReplyPath + suffix, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        403,
      );
    }
    const foreignHost = await new Promise<number | undefined>((done, reject) => {
      const req = request(
        base + grokReplyPath,
        { method: 'POST', headers: { host: 'evil.test', 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          done(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ replyId: ids[0], text: 'bad' }));
    });
    assert.equal(foreignHost, 403);
    assert.equal(
      (
        await fetch(base + '/api/external-agents/grok-bot/routine', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + grokReplyPath, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    const secret = 'crsr_SYNTHETIC_HTTP_SECRET';
    const headers = { 'content-type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner };
    const saved = await fetch(base + '/api/external-agents/grok-bot/routine', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ url: 'https://api2.cursor.sh/automations/webhook/synthetic', key: secret }),
    });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.ok(!savedText.includes(secret));
    assert.ok(savedText.includes('…CRET'));
    const malformed = await fetch(base + '/api/external-agents/grok-bot/routine', {
      method: 'PUT',
      headers,
      body: `{"key":"${secret}"`,
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes(secret));
    const instructions = (await (
      await fetch(base + '/api/external-agents/grok-bot/routine-instructions', { headers })
    ).json()) as {
      text: string;
    };
    assert.ok(instructions.text.includes(`=${port}\n`));
    assert.ok(
      instructions.text.includes(
        `http://127.0.0.1:$${process.platform === 'win32' ? 'pugportPort' : 'pugport_port'}${grokReplyPath}`,
      ),
    );
    assert.ok(!instructions.text.includes(secret));
    const windows = process.platform === 'win32';
    const snippet = instructions.text.split(windows ? '```powershell\n' : '```sh\n')[1]!.split('\n```')[0]!;
    const answer =
      '中文完整答案：你好，世界！\n第二行 🐶\n \'@安全的行首\n引号 " 和反斜线 \\；$(printf should-not-run) `printf neither`';
    // Execute the actual copied command. Quoted heredoc content must stay data, including shell syntax.
    const runSnippet = async (text: string, more = false) => {
      const command = windows
        ? snippet
            .replace('<replyId>', ids[0]!)
            .replace('<final answer>', text)
            .replace(';text=', more ? ';more=$true;text=' : ';text=')
        : snippet.replace(
            '{"replyId":"<replyId>","text":"<final answer>"}',
            JSON.stringify({ replyId: ids[0]!, text, ...(more ? { more: true } : {}) }),
          );
      await promisify(execFile)(
        windows ? 'powershell.exe' : '/bin/sh',
        windows
          ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
          : ['-c', command],
        { windowsHide: true, timeout: 20000 },
      );
    };
    await runSnippet(answer, true);
    assert.equal((await post({ replyId: ids[0], text: answer, more: true })).status, 200);
    const partial = (await (await fetch(base + '/api/conversations/conversation', { headers })).json()) as {
      messages: { id: string; content: string; externalAgent: { status: string } }[];
    };
    const first = partial.messages.find((m) => m.id === messages[0])!;
    assert.equal(first.content, answer);
    assert.equal(first.externalAgent.status, 'working');
    if (windows) {
      const bomCommand = snippet
        .replace('<replyId>', ids[0]!)
        .replace('<final answer>', '带 BOM 的追加答案')
        .replace('; Invoke-RestMethod', '; $b=[byte[]]([Text.Encoding]::UTF8.GetPreamble()+$b); Invoke-RestMethod');
      await promisify(execFile)(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bomCommand, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000 },
      );
    } else {
      assert.equal((await post('\uFEFF' + JSON.stringify({ replyId: ids[0], text: '带 BOM 的追加答案' }))).status, 200);
    }
    const read = async () => {
      const state = (await (await fetch(base + '/api/conversations/conversation', { headers })).json()) as {
        messages: { id: string; content: string; externalAgent: { status: string; untrusted: boolean } }[];
      };
      return state.messages.find((m) => m.id === messages[0])!;
    };
    assert.equal((await read()).content, answer + '\n\n带 BOM 的追加答案');
    assert.equal((await read()).externalAgent.status, 'done');
    assert.equal((await read()).externalAgent.untrusted, true);
    assert.equal(
      (await post({ replyId: ids[1], text: '中'.repeat(99_997), more: true })).status,
      200,
      'route accepts over 256KB',
    );
    assert.equal((await post({ replyId: ids[1], text: '末' })).status, 200, 'multipart total reaches cap');
    assert.equal((await post({ replyId: ids[1], text: '末' })).status, 200, 'duplicate at cap is ignored');
    assert.equal((await post({ replyId: ids[1], text: 'x' })).status, 413, 'total reply cap');
    assert.equal((await post({ replyId: ids[0], text: 'x'.repeat(1024 * 1024) })).status, 413, 'dedicated 1MB limit');
    assert.equal((await post('{bad json')).status, 400);
    const unknown = await post({ replyId: 'd'.repeat(32), text: 'x' });
    const expired = await post({ replyId: ids[2], text: 'x' });
    assert.equal(unknown.status, 404);
    assert.equal(expired.status, 404);
    assert.equal(await unknown.text(), await expired.text());
    for (let i = 0; i < 25; i++) assert.equal((await post({ replyId: 'bad', text: 'x' })).status, 404);
    assert.equal((await post({ replyId: ids[0], text: 'still accepted' })).status, 200);
    assert.ok((await read()).content.endsWith('still accepted'));
    assert.ok(!output.includes(secret));
  },
);
