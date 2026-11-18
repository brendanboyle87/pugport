/*
 * The test_page tool on the server side: the desktop app runs the page (src/electron/page-test.ts) and sends
 * the result back over the IPC channel it owns. Without the desktop app (a plain `npm run dev` server) there
 * is no browser to drive.
 */

type Step = Record<string, unknown>;
type Result = {
  steps: Array<{ step: string; ok: boolean; detail?: string; check: boolean }>;
  screenshots: string[];
  consoleErrors: string[];
  title: string;
  error?: string;
};

import { localPageUrl } from '../shared/local-page.ts';

const actions = ['click', 'type', 'press', 'wait', 'expect_text', 'expect_no_text', 'expect_title', 'screenshot'];
const pending = new Map<number, { resolve: (result: Result) => void; timer: NodeJS.Timeout }>();
let sequence = 0;

/** Called by main.ts for every message from the desktop app; true when it was a page test result. */
export function handlePageTestReply(message: unknown): boolean {
  const reply = message as { type?: string; requestId?: number; result?: Result };
  if (reply?.type !== 'page-test-result' || typeof reply.requestId !== 'number') return false;
  const waiting = pending.get(reply.requestId);
  if (!waiting) return true;
  pending.delete(reply.requestId);
  clearTimeout(waiting.timer);
  waiting.resolve(reply.result ?? { steps: [], screenshots: [], consoleErrors: [], title: '', error: '没有结果。' });
  return true;
}

export function cleanSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error('请用 steps 给出要做的操作和检查，例如点击、输入、检查文字。');
  return value.slice(0, 40).map((raw, index) => {
    const step = (raw ?? {}) as Step;
    if (!actions.includes(String(step.action)))
      throw new Error(`第 ${index + 1} 步的 action 不认识：${String(step.action)}`);
    const text = (key: string, max = 500) =>
      typeof step[key] === 'string' ? (step[key] as string).slice(0, max) : undefined;
    return {
      action: step.action,
      ...(text('target') ? { target: text('target') } : {}),
      ...(text('text', 2000) !== undefined ? { text: text('text', 2000) } : {}),
      ...(text('key', 40) ? { key: text('key', 40) } : {}),
      ...(text('name', 40) ? { name: text('name', 40) } : {}),
      ...(typeof step.ms === 'number' ? { ms: Math.max(0, Math.min(step.ms, 10_000)) } : {}),
    };
  });
}

export async function testPage(args: Record<string, unknown>, options: { readOnly?: boolean } = {}): Promise<string> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('请用 url 给出要测试的本机页面地址，例如 http://localhost:5173/。');
  if (!localPageUrl(url)) throw new Error('只能测试本机页面（localhost、127.0.0.1 或本地文件）。');
  const steps = cleanSteps(args.steps);
  if (options.readOnly && steps.some((step) => ['click', 'type', 'press'].includes(String(step.action))))
    throw new Error('这次运行是只读的，页面测试只能检查、等待或截图，不能点击、输入或按键。');
  if (!process.send) throw new Error('页面测试需要在 PugPort 桌面版里使用。');
  const requestId = ++sequence;
  const result = await new Promise<Result>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ steps: [], screenshots: [], consoleErrors: [], title: '', error: '页面测试 3 分钟内没有完成。' });
    }, 180_000);
    pending.set(requestId, { resolve, timer });
    process.send!({
      type: 'page-test',
      requestId,
      request: { url, steps, viewport: args.viewport === 'mobile' ? 'mobile' : 'desktop' },
    });
  });
  return describe(url, result);
}

/** Actions that ran and checks that passed, counted apart; then each step, screenshots and console errors. */
export function describe(url: string, result: Result): string {
  const actions = result.steps.filter((step) => !step.check);
  const checks = result.steps.filter((step) => step.check);
  const lines = [
    `页面测试：${url}${result.title ? `（标题：${result.title}）` : ''}`,
    `操作完成 ${actions.filter((step) => step.ok).length}/${actions.length}；检查通过 ${checks.filter((step) => step.ok).length}/${checks.length}。` +
      (checks.length ? '' : '这次没有检查项：操作做完不代表页面是对的，请加上 expect_text 等检查。'),
  ];
  if (result.error) lines.push(`出错：${result.error}`);
  for (const step of result.steps)
    lines.push(`${step.ok ? '✓' : '✗'} ${step.step}${step.detail ? ` —— ${step.detail}` : ''}`);
  if (result.screenshots.length) lines.push('', `截图：${result.screenshots.join('；')}`);
  if (result.consoleErrors.length)
    lines.push(
      '',
      `页面控制台报错（${result.consoleErrors.length}）：`,
      ...result.consoleErrors.slice(0, 8).map((line) => `- ${line}`),
    );
  lines.push('', '把通过的检查和截图路径作为完成依据；失败的检查要如实说明或修复后重测。');
  return lines.join('\n');
}
