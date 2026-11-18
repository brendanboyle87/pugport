import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { grokRoutineInstructions } from '../src/server/external-agents/grok-routine.ts';
import { desktopEndpointFile } from '../src/server/platform/desktop-endpoint.ts';

const fallback = 54321;
const psQuote = (path: string) => `'${path.replace(/['‘’‚‛]/g, '$&$&')}'`;
const shQuote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

function snippet(platform: NodeJS.Platform, file?: string) {
  const language = platform === 'win32' ? 'powershell' : 'sh';
  return grokRoutineInstructions(fallback, platform, file)
    .split('```' + language + '\n')[1]!
    .split('\n```')[0]!;
}

for (const platform of ['win32', 'linux', 'darwin'] as const) {
  test(`${platform} reply command discovers the current port and preserves reply encoding`, () => {
    const file = platform === 'win32' ? "C:\\Synthetic Owner's\\desktop-endpoint.json" : "/tmp/Owner's/endpoint.json";
    const text = grokRoutineInstructions(fallback, platform, file);
    const command = snippet(platform, file);
    assert.ok(command.includes(platform === 'win32' ? psQuote(file) : shQuote(file)));
    assert.ok(command.includes(String(fallback)));
    assert.ok(!command.includes(`http://127.0.0.1:${fallback}/`));
    assert.match(text, /自动找到 PugPort 当前的端口/);
    assert.match(text, /发现文件.*54321/);
    assert.match(text, /只发送答案，不发送进度消息/);
    assert.match(text, /超过约 8000 字符时，在段落边界分成/);
    if (platform === 'win32') {
      assert.match(command, /Get-Content -LiteralPath .* -Raw -ErrorAction Stop \| ConvertFrom-Json/);
      assert.match(command, /try \{[\s\S]*catch \{\}/);
      assert.ok(
        command.includes(
          "$b=[Text.Encoding]::UTF8.GetBytes((@{replyId='<replyId>';text=@'\n<final answer>\n'@} | ConvertTo-Json -Compress))",
        ),
      );
      assert.ok(text.includes("回答里如有一行以 '@ 开头，在它前面加一个空格"));
      assert.ok(text.includes("结束标记 '@} 必须从行首开始，前面不能有空格"));
      assert.ok(text.includes("replyId='<replyId>'; 后添加 more=$true;，最后一段不加 more"));
    } else {
      assert.match(command, /curl --fail --silent --show-error --max-time 15/);
      assert.ok(
        command.includes(
          '<<\'PUGPORT_REPLY_JSON\'\n{"replyId":"<replyId>","text":"<final answer>"}\nPUGPORT_REPLY_JSON',
        ),
      );
      assert.match(text, /请求体必须是一行有效 JSON/);
      assert.ok(text.includes('换行写成 \\n'));
      assert.ok(text.includes('"more":true'));
      assert.match(text, /不要自动重试/);
      assert.doesNotMatch(command, /\b(?:jq|python|python3)\b/);
    }
  });
}

test('default discovery path comes from the generating machine, independently of the command platform', () => {
  const file = desktopEndpointFile();
  assert.ok(snippet('win32').includes(psQuote(file)));
  assert.ok(snippet('linux').includes(shQuote(file)));
  assert.ok(snippet('darwin').includes(shQuote(file)));
});

for (const platform of ['win32', 'linux'] as const) {
  test(`${platform} generated port selection runs locally without executing the POST`, async (t) => {
    const shell = platform === 'win32' ? 'powershell' : 'sh';
    const args = platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command'] : ['-c'];
    const available = spawnSync(shell, [...args, 'exit 0'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if ((available.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      t.skip(`${shell} is not installed or is not on PATH`);
      return;
    }
    assert.ifError(available.error);
    assert.equal(available.status, 0, available.stderr);
    const directory = mkdtempSync(join(tmpdir(), 'grok-port-shell-'));
    t.after(() => {
      assert.equal(dirname(directory), tmpdir());
      rmSync(directory, { recursive: true, force: true });
    });
    // PowerShell also treats curly quotes as single quotes, so a profile like O’Brien must not break parsing.
    const path = join(directory, "endpoint's O’Brien $literal.json");
    const file = platform === 'win32' ? path : path.replaceAll('\\', '/');
    const command = snippet(platform, file);
    const boundary = platform === 'win32' ? '\n$b=' : '\ncurl ';
    const offset = command.indexOf(boundary);
    assert.ok(offset > 0, 'port selection must precede the POST');
    const selection = command.slice(0, offset);
    assert.doesNotMatch(selection, /Invoke-RestMethod|curl|replyId/);
    const print = platform === 'win32' ? '\nWrite-Output $pugportPort' : '\nprintf "%s\\n" "$pugport_port"';
    for (const [label, body, expected] of [
      ['missing', undefined, fallback],
      ['valid', '{"port":4931,"pid":123,"instance":"synthetic"}', 4931],
      ['pretty CRLF', '{\r\n  "port": 5223,\r\n  "pid": 123,\r\n  "instance": "synthetic"\r\n}', 5223],
      ['lower bound', '{"port":1}', 1],
      ['upper bound', '{"port":65535}', 65535],
      ['garbage', 'not JSON', fallback],
      ['missing port', '{"pid":123}', fallback],
      ['zero', '{"port":0}', fallback],
      ['negative', '{"port":-1}', fallback],
      ['out of range', '{"port":65536}', fallback],
      ['huge integer', '{"port":999999999999999999999999999999}', fallback],
      ['fraction', '{"port":4317.5}', fallback],
      ['string', '{"port":"4317"}', fallback],
      ['null', '{"port":null}', fallback],
      ['boolean', '{"port":true}', fallback],
    ] as const) {
      await t.test(label, () => {
        if (body !== undefined) writeFileSync(path, body);
        const result = spawnSync(shell, [...args, selection + print], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), String(expected));
        assert.equal(result.stderr, '');
      });
    }
    await t.test('unreadable file (directory)', () => {
      const unreadable = snippet(platform, platform === 'win32' ? directory : directory.replaceAll('\\', '/'));
      const result = spawnSync(shell, [...args, unreadable.slice(0, unreadable.indexOf(boundary)) + print], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), String(fallback));
      assert.equal(result.stderr, '');
    });
  });
}
