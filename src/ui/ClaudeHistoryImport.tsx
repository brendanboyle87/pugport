import { currentLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Conversation, Project } from '../shared/types';
import type {
  ClaudeHistoryInput,
  ClaudeHistoryPreview,
  ClaudeHistoryImportResult,
} from '../server/claude-history-import';
import type { Api } from './Workspace';
import { readableError } from './App';
import { useUiUpdateBlocker } from './ui-update-guard';

export function ClaudeHistoryImport({
  project,
  api,
  onOpen,
  onClose,
}: {
  project: Project;
  api: Api;
  onOpen: (id: string, imported?: Conversation) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const [file, setFile] = useState<ClaudeHistoryInput>();
  const [preview, setPreview] = useState<ClaudeHistoryPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useUiUpdateBlocker(() => true);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      generation.current++;
      previous?.focus();
    };
  }, []);
  async function choose(selected?: File) {
    if (!selected || pending.current) return;
    const request = ++generation.current;
    pending.current = true;
    setBusy(true);
    setError('');
    setFile(undefined);
    setPreview(undefined);
    try {
      if (!/\.(?:json|jsonl)$/i.test(selected.name) || !selected.size || selected.size > 10 * 1024 * 1024)
        throw new Error('请选择不超过 10 MiB 的 JSON 或 JSONL 文件');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
      } catch {
        throw new Error('无法读取 UTF-8 导出文件');
      }
      if (generation.current !== request) return;
      const input = { name: selected.name, text };
      const next = await api<ClaudeHistoryPreview>(
        `/api/projects/${encodeURIComponent(project.id)}/claude-history/preview`,
        input,
      );
      if (generation.current === request) {
        setFile(input);
        setPreview(next);
      }
    } catch (failure) {
      if (generation.current === request) setError(readableError(failure));
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function importChat(conversationId: string) {
    if (pending.current || !file || !preview) return;
    const request = generation.current;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<ClaudeHistoryImportResult>(
        `/api/projects/${encodeURIComponent(project.id)}/claude-history/import`,
        { ...file, fingerprint: preview.fingerprint, conversationId },
      );
      if (generation.current === request && (await onOpen(result.conversation.id, result.conversation))) onClose();
    } catch (failure) {
      if (generation.current === request) setError(readableError(failure));
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className="modal cursor-import-dialog"
      aria-label="导入 Claude 历史"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
    >
      <header className="modal-heading">
        <h2>导入 Claude 历史</h2>
        <button autoFocus type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p className="muted" translate="no">
        {project.name}
      </p>
      <p>选择自己导出的 Claude JSON 或 Claude Code JSONL 文件。原文件保留，只迁入用户与助手的文字、时间和来源。</p>
      <p className="muted">
        这是只读历史，不是原生会话续接。工具执行、隐藏推理、旧审批和登录凭据不会恢复。需要继续开发时，请新建工作线并重新给予当前授权。
      </p>
      <label className="button">
        选择导出文件
        <input
          type="file"
          accept=".json,.jsonl,application/json,application/x-ndjson"
          disabled={busy}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            void choose(selected);
          }}
        />
      </label>
      {file && <p translate="no">{file.name}</p>}
      {busy && <p role="status">处理中…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <p className="muted">已忽略非对话记录、工具内容和附件；可识别的敏感凭据已脱敏。</p>
          <ul className="cursor-import-list" aria-label="可导入的 Claude 对话" aria-busy={busy}>
            {preview.conversations.map((chat) => (
              <li key={chat.id}>
                <div className="cursor-import-copy">
                  <strong translate="no">{chat.title}</strong>
                  <small>{chat.messageCount} 条消息</small>
                  {chat.createdAt && (
                    <time dateTime={chat.createdAt}>{new Date(chat.createdAt).toLocaleString(currentLocale())}</time>
                  )}
                </div>
                <button type="button" className="button" disabled={busy} onClick={() => void importChat(chat.id)}>
                  导入并打开
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </dialog>
  );
}
