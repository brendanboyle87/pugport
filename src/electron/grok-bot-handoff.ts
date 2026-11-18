import { grokBotUrl, grokBotUsageUrl, grokBotIdPattern } from '../shared/external-agents.ts';
import type { WebAgentResult } from '../shared/web-bridge.ts';

/** Handles only the registered desktop links, before any web window is created. */
export async function grokBotDesktopRequest(
  raw: unknown,
  dependencies: { clipboard: { writeText(text: string): void }; openExternal(url: string): Promise<void> },
): Promise<WebAgentResult> {
  const request = raw as { agentId?: unknown; action?: unknown; url?: unknown; text?: unknown } | null;
  if (
    !request ||
    request.agentId !== 'grok-bot' ||
    !['desktop-open', 'desktop-handoff'].includes(String(request.action))
  )
    return { ok: false, code: 'error', message: 'Grok Bot 只支持桌面交接。' };
  const name = 'Grok Bot';
  let allowed = request.url === grokBotUrl() || request.url === grokBotUsageUrl;
  if (typeof request.url === 'string' && request.url.startsWith('grokbot://app/v1/agent?id=')) {
    const id = request.url.slice('grokbot://app/v1/agent?id='.length);
    allowed = grokBotIdPattern.test(id) && request.url === grokBotUrl(id);
  }
  if (!allowed || (request.action === 'desktop-handoff' && request.url === grokBotUsageUrl))
    return { ok: false, code: 'error', message: `${name} 链接无效。` };
  if (
    request.action === 'desktop-handoff' &&
    (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 100_000)
  )
    return { ok: false, code: 'error', message: '交接消息无效。' };
  try {
    if (request.action === 'desktop-handoff') dependencies.clipboard.writeText(request.text as string);
    await dependencies.openExternal(request.url as string);
    return { ok: true };
  } catch {
    return { ok: false, code: 'error', message: `没能打开 ${name}，请确认已安装；消息若已复制，可手动粘贴。` };
  }
}
