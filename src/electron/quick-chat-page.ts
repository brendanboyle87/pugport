import { composerEnterAction } from '../shared/composer-enter.ts';

export type QuickChatLabels = ReturnType<typeof quickChatLabels>;

export function quickChatLabels(
  t: (text: string) => string,
  sendKey: 'enter' | 'ctrl-enter' = 'enter',
  platform = process.platform,
) {
  return {
    title: t('快捷聊天'),
    placeholder: t('想聊什么？'),
    open: t('打开对话'),
    close: t('关闭'),
    send: t('发送'),
    hint:
      sendKey === 'ctrl-enter'
        ? t('Ctrl+Enter 发送 · Enter 换行 · Esc 收起').replaceAll('Ctrl+', platform === 'darwin' ? 'Cmd+' : 'Ctrl+')
        : t('Enter 发送 · Shift+Enter 换行 · Esc 收起'),
    failed: t('发送失败，输入已保留，请重试。'),
  };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function quickChatHtml(labels: QuickChatLabels) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark"><title>PugPort</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:22px 24px;background:#fafaf9;color:#202323;font:14px "Segoe UI",sans-serif}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px}header{margin-bottom:10px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600}.mark{width:9px;height:9px;border-radius:50%;background:#3d8b79}
button,a{font:inherit}button{cursor:pointer}#close{border:0;background:transparent;color:#737977;font-size:21px;padding:0 5px}
#target{color:#737977;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:14px}
textarea{width:100%;height:104px;resize:none;border:0;background:transparent;color:inherit;font:16px/1.6 "Segoe UI",sans-serif;padding:0;outline:none}
textarea::placeholder{color:#9b9f9d}footer{border-top:1px solid #e4e7e4;padding-top:14px;margin-top:8px}a{font-size:12px;color:#337767;text-decoration:none}
a:hover{text-decoration:underline}#hint{color:#888e8b;font-size:11px}#send{border:0;border-radius:9px;background:#327a68;color:white;padding:8px 16px;font-weight:600}
#send:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:2px solid #64a996;outline-offset:3px}
#error{color:#bb493e;font-size:12px;min-height:18px;margin-top:10px;overflow:auto;max-height:36px}
@media(prefers-color-scheme:dark){body{background:#191c1b;color:#eeefed}footer{border-color:#343a37}#target,#hint{color:#a3aaa6}a{color:#8bc7b7}#error{color:#f09589}}
</style></head><body>
<header><div class="brand"><span class="mark"></span><span id="title">${escape(labels.title)}</span></div><button id="close" aria-label="${escape(labels.close)}">×</button></header>
<div id="target"></div><textarea id="input" autofocus maxlength="50000" aria-label="${escape(labels.title)}" placeholder="${escape(labels.placeholder)}"></textarea>
<footer><a id="open" href="pugport-quick-chat:open">${escape(labels.open)}</a><span id="hint">${escape(labels.hint)}</span><button id="send" disabled>${escape(labels.send)}</button></footer>
<div id="error" role="alert"></div></body></html>`;
}

/** Runs only in the isolated preload world. No page scripts or Node APIs are exposed. */
export function bindQuickChat(document: Document, api: { send(text: string): Promise<void>; close(): Promise<void> }) {
  const input = document.querySelector<HTMLTextAreaElement>('#input')!;
  const send = document.querySelector<HTMLButtonElement>('#send')!;
  const error = document.querySelector<HTMLElement>('#error')!;
  let pending = false;
  let sendKey: 'enter' | 'ctrl-enter' = 'enter';
  let composition = { active: false, endedAt: -Infinity };
  let failed = '';
  const sync = () => {
    send.disabled = pending || !input.value.trim();
  };
  const submit = async () => {
    if (pending || !input.value.trim()) return;
    pending = true;
    input.readOnly = true;
    error.textContent = '';
    sync();
    try {
      await api.send(input.value);
      input.value = '';
    } catch (reason) {
      error.textContent =
        reason instanceof Error
          ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || failed
          : failed;
    } finally {
      pending = false;
      input.readOnly = false;
      sync();
      input.focus();
    }
  };
  input.addEventListener('compositionstart', () => {
    composition = { active: true, endedAt: -Infinity };
  });
  input.addEventListener('compositionend', () => {
    composition = { active: false, endedAt: performance.now() };
  });
  input.addEventListener('blur', () => {
    composition = { active: false, endedAt: -Infinity };
  });
  input.addEventListener('keyup', (event) => {
    if (event.key === 'Enter' && !composition.active) composition.endedAt = -Infinity;
  });
  input.addEventListener('input', sync);
  send.addEventListener('click', () => void submit());
  document.querySelector('#close')!.addEventListener('click', () => void api.close());
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void api.close();
    }
    if (event.target === input) {
      const action = composerEnterAction(event, composition, performance.now(), sendKey);
      if (action === 'send' || action === 'ignore') event.preventDefault();
      if (action === 'send') void submit();
    }
  });
  return (state: { target: string; labels: QuickChatLabels; composerSendKey?: 'enter' | 'ctrl-enter' }) => {
    const { labels } = state;
    sendKey = state.composerSendKey ?? 'enter';
    failed = labels.failed;
    for (const id of ['title', 'open', 'hint', 'send'] as const)
      document.querySelector(`#${id}`)!.textContent = labels[id];
    document.querySelector('#target')!.textContent = state.target;
    document.querySelector('#target')!.setAttribute('title', state.target);
    document.querySelector('#close')!.setAttribute('aria-label', labels.close);
    input.placeholder = labels.placeholder;
    input.setAttribute('aria-label', labels.title);
    input.focus();
  };
}
