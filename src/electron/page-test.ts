import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAppPageRequest, localPageUrl } from '../shared/local-page.ts';

/*
 * Page tests for executors (the test_page tool): a hidden window with its own throwaway storage — never the
 * user's browser, cookies or sign-ins — opens a local page, follows the steps (click, type, press, wait),
 * checks what the page shows, and saves screenshots. Actions done and checks passed are reported apart:
 * "the steps ran" is not "the page is right".
 */

export type PageStep =
  | { action: 'click'; target: string }
  | { action: 'type'; target?: string; text: string }
  | { action: 'press'; key: string }
  | { action: 'wait'; ms?: number; text?: string }
  | { action: 'expect_text'; text: string }
  | { action: 'expect_no_text'; text: string }
  | { action: 'expect_title'; text: string }
  | { action: 'screenshot'; name?: string };
export type PageTestRequest = { url: string; steps: PageStep[]; viewport?: 'desktop' | 'mobile' };
export type PageTestResult = {
  steps: Array<{ step: string; ok: boolean; detail?: string; check: boolean }>;
  screenshots: string[];
  consoleErrors: string[];
  title: string;
  error?: string;
};

const describe = (step: PageStep) =>
  step.action === 'click'
    ? `点击“${step.target}”`
    : step.action === 'type'
      ? `${step.target ? `在“${step.target}”` : ''}输入“${step.text}”`
      : step.action === 'press'
        ? `按 ${step.key}`
        : step.action === 'wait'
          ? step.text
            ? `等待出现“${step.text}”`
            : `等待 ${step.ms ?? 500} 毫秒`
          : step.action === 'expect_text'
            ? `检查页面有“${step.text}”`
            : step.action === 'expect_no_text'
              ? `检查页面没有“${step.text}”`
              : step.action === 'expect_title'
                ? `检查标题含“${step.text}”`
                : '截图';

/** Finds the element a step names — a CSS selector, or visible text / label / placeholder — and returns its centre. */
const locate = (target: string) => `(() => {
  const target = ${JSON.stringify(target)};
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let el = null;
  if (/^[#.\\[]|^[a-z]+[#.\\[:]/i.test(target)) { try { el = document.querySelector(target); } catch {} }
  if (!el) {
    const label = (node) => [node.innerText, node.getAttribute('aria-label'), node.getAttribute('placeholder'), node.getAttribute('title'), node.value].filter(Boolean).map((v) => String(v).trim());
    const candidates = [...document.querySelectorAll('button, a, input, textarea, select, [role=button], [role=tab], [role=menuitem], label, [onclick], [tabindex]')].filter(visible);
    el = candidates.find((n) => label(n).some((v) => v === target)) || candidates.find((n) => label(n).some((v) => v.includes(target)));
    if (!el) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let best = null;
      while (walker.nextNode()) { const n = walker.currentNode; if (visible(n) && n.innerText && n.innerText.trim() === target) best = n; }
      el = best;
    }
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
})()`;

const keyCodes: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
};

export async function runPageTest(request: PageTestRequest, dataDir: string, appPort: number): Promise<PageTestResult> {
  const result: PageTestResult = { steps: [], screenshots: [], consoleErrors: [], title: '' };
  if (!localPageUrl(request.url)) return { ...result, error: '只能测试本机页面（localhost、127.0.0.1 或本地文件）。' };
  if (!Number.isSafeInteger(appPort) || appPort < 1 || appPort > 65535)
    return { ...result, error: '无法确认应用后台地址，未打开测试页面。' };
  if (isAppPageRequest(request.url, appPort)) return { ...result, error: '页面测试不能访问 PugPort 本身。' };
  const mobile = request.viewport === 'mobile';
  const window = new BrowserWindow({
    width: mobile ? 390 : 1280,
    height: mobile ? 844 : 860,
    show: false,
    webPreferences: {
      offscreen: true,
      // A fresh in-memory session: nothing from the user's browsing, and nothing kept afterwards.
      partition: `page-test-${randomUUID()}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = window.webContents;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  // Includes redirects, frames, fetch and WebSocket requests from the isolated session.
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isAppPageRequest(details.url, appPort) });
  });
  const restrictNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!localPageUrl(url) || isAppPageRequest(url, appPort)) {
      event.preventDefault();
      result.error = '页面跳转到不允许测试的地址，已拦截。';
    }
  };
  contents.on('will-navigate', restrictNavigation);
  contents.on('will-redirect', restrictNavigation);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('console-message', (event) => {
    const details = event as unknown as { level?: string; message?: string };
    if (details.level === 'error' && details.message) result.consoleErrors.push(details.message.slice(0, 300));
  });
  const folder = join(dataDir, 'page-tests');
  await mkdir(folder, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const shot = async (name: string) => {
    const path = join(folder, `${id}-${name}.png`);
    await writeFile(path, (await contents.capturePage()).toPNG());
    result.screenshots.push(path);
    return path;
  };
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const run = <T>(script: string) => contents.executeJavaScript(script, true) as Promise<T>;
  const bodyText = () => run<string>('document.body ? document.body.innerText : ""');
  try {
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        window.loadURL(request.url),
        new Promise<never>((_, reject) => {
          loadTimer = setTimeout(() => reject(new Error('页面 30 秒内没有加载完。')), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(loadTimer);
    }
    await pause(400);
    let actionsFailed = false;
    for (const step of request.steps.slice(0, 40)) {
      if (result.error) break;
      const check = step.action.startsWith('expect_');
      // After a failed action the rest of the journey is meaningless; checks still report what the page shows.
      if (actionsFailed && !check) {
        result.steps.push({ step: describe(step), ok: false, detail: '前面的操作失败，未执行', check });
        continue;
      }
      let ok = true,
        detail: string | undefined;
      if (step.action === 'click') {
        const at = await run<{ x: number; y: number } | null>(locate(step.target));
        if (!at) [ok, detail] = [false, '找不到这个元素'];
        else {
          contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          await pause(300);
        }
      } else if (step.action === 'type') {
        if (step.target) {
          const at = await run<{ x: number; y: number } | null>(locate(step.target));
          if (!at) [ok, detail] = [false, '找不到输入框'];
          else {
            contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            await pause(100);
          }
        }
        if (ok) {
          await contents.insertText(step.text);
          await pause(200);
        }
      } else if (step.action === 'press') {
        const keyCode = keyCodes[step.key.toLowerCase()] ?? step.key;
        contents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Enter' || keyCode.length === 1)
          contents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode });
        contents.sendInputEvent({ type: 'keyUp', keyCode });
        await pause(300);
      } else if (step.action === 'wait') {
        if (step.text) {
          const until = Date.now() + 10_000;
          while (!(await bodyText()).includes(step.text) && Date.now() < until) await pause(200);
          if (!(await bodyText()).includes(step.text)) [ok, detail] = [false, '10 秒内没有出现'];
        } else await pause(Math.min(step.ms ?? 500, 10_000));
      } else if (step.action === 'expect_text') {
        ok = (await bodyText()).includes(step.text);
        if (!ok) detail = '页面上没有这段文字';
      } else if (step.action === 'expect_no_text') {
        ok = !(await bodyText()).includes(step.text);
        if (!ok) detail = '页面上仍有这段文字';
      } else if (step.action === 'expect_title') {
        const title = contents.getTitle();
        ok = title.includes(step.text);
        if (!ok) detail = `实际标题：${title}`;
      } else if (step.action === 'screenshot') {
        detail = await shot(step.name?.replace(/[^\w-]/g, '').slice(0, 30) || `step${result.steps.length + 1}`);
      }
      if (!ok && !check) actionsFailed = true;
      result.steps.push({ step: describe(step), ok, ...(detail ? { detail } : {}), check });
    }
    result.title = contents.getTitle();
    await shot('final');
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    await shot('error').catch(() => undefined);
  } finally {
    window.destroy();
  }
  return result;
}
