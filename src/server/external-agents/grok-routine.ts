import { UnderTestError } from '../platform/under-test.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { keyHint, secretsDirectory } from '../api-providers.ts';
import { writePrivateConfig } from '../private-config.ts';
import { desktopEndpointFile } from '../platform/desktop-endpoint.ts';

export const grokWebhookHosts = ['api2.cursor.sh'] as const;
export const grokReplyPath = '/api/external/grok-bot/replies';
export const grokWaitingNote = '已交给 Grok Bot，等它回复…';
export const grokReplyHash = (id: string) => createHash('sha256').update(id).digest('hex');

export function validGrokWebhook(value: string) {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol === 'https:' &&
      grokWebhookHosts.some((host) => host === url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/automations\/webhook\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      return url.href;
  } catch {
    /* Report only a fixed message, never supplied credentials. */
  }
  throw new Error('例程网址必须是 api2.cursor.sh 的 HTTPS webhook 地址。');
}

type Routine = { url: string; key: string };
export class GrokRoutineStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file = join(secretsDirectory(), 'grok-routine.json')) {}
  private load(): { text: string; routine?: Routine } {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本机例程设置。');
    }
    if (!text) return { text };
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('本机例程设置格式无效，未覆盖原文件。');
    }
    try {
      return { text, routine: { url: validGrokWebhook(value?.url), key: this.validKey(value?.key) } };
    } catch {
      return { text };
    }
  }
  private validKey(key: string) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(key.trim())) throw new Error('例程密钥格式不对。');
    return key.trim();
  }
  read() {
    return this.load().routine;
  }
  view() {
    const routine = this.read();
    return routine ? { url: routine.url, keyHint: keyHint(routine.key)! } : undefined;
  }
  save(url: string, key?: string) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const { text, routine } = this.load();
        const value = url.trim() ? { url: validGrokWebhook(url), key: this.validKey(key || routine?.key || '') } : null;
        await writePrivateConfig(this.file, JSON.stringify(value) + '\n', text);
      });
    this.writes = next;
    return next;
  }
}

export async function postGrokRoutine(
  routine: Routine,
  message: string,
  replyId: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; note?: string; runUuid?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await (options.fetch ?? fetch)(validGrokWebhook(routine.url), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        headers: { Authorization: `Bearer ${routine.key}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message, replyId }),
      });
      if (response.status === 429 && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      if (response.status === 200) {
        const body = await response.json().catch(() => undefined);
        const runUuid =
          typeof body?.runUuid === 'string' &&
          /^[a-f0-9-]{36}$/i.test(body.runUuid) &&
          !body.runUuid.includes(routine.key)
            ? body.runUuid
            : undefined;
        return { ok: true, ...(runUuid ? { runUuid } : {}) };
      }
      await response.body?.cancel();
      return {
        ok: false,
        note:
          response.status === 401 || response.status === 403
            ? '密钥无效或已过期'
            : response.status === 404
              ? '这个例程的网址不对'
              : response.status >= 500 && response.status <= 599
                ? '没能确认例程是否启动，请到 Grok Bot 窗口查看，避免重复计费。'
                : 'Grok Bot 例程启动失败，请稍后查看。',
      };
    } catch (error) {
      if (error instanceof UnderTestError) return { ok: false, note: error.message };
      // The run may already be billed: network failures and timeouts must never be retried automatically.
      return { ok: false, note: '没能确认例程是否启动，请到 Grok Bot 窗口查看，避免重复计费。' };
    }
  }
  return { ok: false, note: 'Grok Bot 例程启动失败，请稍后查看。' };
}

export function grokRoutineInstructions(
  port: number,
  platform: NodeJS.Platform = process.platform,
  endpointFile = desktopEndpointFile(),
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本机服务还没开始监听。');
  if (platform !== 'win32')
    return `这个例程接收我从 PugPort 发来的任务。请求体中的 message 是任务，请像我在这个聊天里亲自输入一样执行；replyId 用于把最终答案送回对应消息。
完成后，在我的电脑上运行下面的终端命令来回复。填入本次请求的 replyId 和最终答案。只发送答案，不发送进度消息，不要为了回复运行其他本地命令。
请求体必须是一行有效 JSON：答案中的双引号和反斜线必须转义，换行写成 \\n；不要把答案直接粘贴成多行 shell 命令。保留带单引号的 PUGPORT_REPLY_JSON 标记，避免答案中的 shell 字符被执行。
答案超过约 8000 字符时，在段落边界分成每段不超过约 8000 字符的多段，按顺序发送并使用同一个 replyId（可加 "part":1、2… 标明段号）；除最后一段外，在每段的 JSON 对象中添加 "more":true，最后一段不加 more。命令失败时先查看 Grok Bot 中的状态，不要自动重试。
命令会自动找到 PugPort 当前的端口，读不到发现文件时用 ${port}。
\n\`\`\`sh
pugport_port=${port}
pugport_candidate=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*[,}].*/\\1/p' '${endpointFile.replaceAll("'", "'\\''")}' 2>/dev/null)
case "$pugport_candidate" in
  ''|*[!0-9]*) ;;
  *) if [ "\${#pugport_candidate}" -le 5 ] && [ "$pugport_candidate" -ge 1 ] && [ "$pugport_candidate" -le 65535 ]; then
       pugport_port=$pugport_candidate
     fi ;;
esac
curl --fail --silent --show-error --max-time 15 --request POST \\
  --header 'Content-Type: application/json; charset=utf-8' \\
  --data-binary @- "http://127.0.0.1:$pugport_port${grokReplyPath}" <<'PUGPORT_REPLY_JSON'
{"replyId":"<replyId>","text":"<final answer>"}
PUGPORT_REPLY_JSON
\`\`\``;
  return `这个例程接收我从 PugPort 发来的任务。请求体中的 message 是任务，请像我在这个聊天里亲自输入一样执行；replyId 用于把最终答案送回对应消息。
完成后，在我的电脑上运行下面的 PowerShell 命令来回复。填入本次请求的 replyId 和最终答案。只发送答案，不发送进度消息，不要为了回复运行其他本地命令。
回答里如有一行以 '@ 开头，在它前面加一个空格。
结束标记 '@} 必须从行首开始，前面不能有空格。答案超过约 8000 字符时，在段落边界分成每段不超过约 8000 字符的多段，按顺序发送并使用同一个 replyId（可加 part=1;、2… 标明段号）；除最后一段外，在每段的 replyId='<replyId>'; 后添加 more=$true;，最后一段不加 more。
命令会自动找到 PugPort 当前的端口，读不到发现文件时用 ${port}。
\n\`\`\`powershell
$pugportPort=${port}
try {
  $pugportCandidate=(Get-Content -LiteralPath '${endpointFile.replace(/['‘’‚‛]/g, '$&$&')}' -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop).port
  if (($pugportCandidate -is [int] -or $pugportCandidate -is [long]) -and $pugportCandidate -ge 1 -and $pugportCandidate -le 65535) { $pugportPort=$pugportCandidate }
} catch {}
$b=[Text.Encoding]::UTF8.GetBytes((@{replyId='<replyId>';text=@'
<final answer>
'@} | ConvertTo-Json -Compress)); Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$pugportPort${grokReplyPath}" -ContentType 'application/json; charset=utf-8' -Body $b
\`\`\``;
}
