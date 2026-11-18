import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { X } from 'lucide-react';
import { desktopBridge } from './desktop';
import type { Api } from './Workspace';

const ProjectPaths = createContext(false);
export const useProjectPaths = () => useContext(ProjectPaths);
type Resolution = { path?: string; paths?: string[]; truncated?: boolean };
type Notify = (value: { tone: 'error'; message: string }) => void;
type Editor = 'vscode' | 'cursor';
export type ReplyPathOpener = (target: Element, editor: Editor) => Promise<void>;

/** Shared by main chat, live output and side chat. A reveal only opens Explorer, never the file itself. */
export async function revealReplyPath(path: string, api: Api) {
  const bridge = desktopBridge();
  if (!bridge?.revealPath) return api('/api/reveal', { path });
  const result = await bridge.revealPath(path);
  if (result === 'missing') throw new Error(`找不到：${path}`);
  if (result !== 'ok') throw new Error(`无法打开：${path}`);
}

export function ReplyPaths({
  ref,
  projectPath,
  scope,
  api,
  notify,
  children,
}: {
  ref?: Ref<ReplyPathOpener>;
  projectPath?: string;
  scope?: string;
  api: Api;
  notify: Notify;
  children: ReactNode;
}) {
  const [choice, setChoice] = useState<{ name: string; paths: string[]; truncated?: boolean; editor?: Editor }>();
  const sequence = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useImperativeHandle(ref, () => activate);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  useEffect(() => {
    sequence.current++;
    setChoice(undefined);
  }, [projectPath, scope]);
  useEffect(() => {
    if (choice) dialog.current?.showModal();
  }, [choice]);
  function dismiss() {
    sequence.current++;
    setChoice(undefined);
  }
  async function open(path: string, editor?: Editor) {
    if (!editor) return revealReplyPath(path, api);
    const result = await desktopBridge()
      ?.openEditor?.({ editor, path })
      .catch(() => 'failed');
    if (result === 'invalid') throw new Error(`无法打开：${path}`);
    if (result !== 'ok') throw new Error(editor === 'vscode' ? '没找到 VS Code' : '没找到 Cursor');
  }
  async function activate(target: Element, editor?: Editor) {
    const path = target.getAttribute('data-local-path') ?? target.getAttribute('data-relative-path');
    if (!path) return;
    const request = ++sequence.current;
    try {
      if (target.hasAttribute('data-local-path')) {
        await open(path, editor);
        return;
      }
      const scope = target.closest('[data-path-scope], .conversation-message, .side-chat-message');
      const bases = [...(scope?.querySelectorAll('[data-local-path]') ?? [])]
        .map((element) => element.getAttribute('data-local-path')!)
        .filter(Boolean)
        .slice(0, 40);
      const result = await api<Resolution>('/api/resolve-path', {
        path,
        bases,
        ...(projectPath ? { projectPath } : {}),
      });
      if (sequence.current !== request) return;
      const paths = [...new Set(result.paths ?? (result.path ? [result.path] : []))];
      if (paths.length === 1 && !result.truncated) await open(paths[0]!, editor);
      else if (paths.length || result.truncated) setChoice({ name: path, paths, truncated: result.truncated, editor });
      else throw new Error(`找不到：${path}`);
    } catch (error) {
      if (sequence.current === request)
        notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return (
    <ProjectPaths.Provider value={!!projectPath}>
      <div
        className="reply-path-scope"
        onClick={(event) => {
          const target = (event.target as Element).closest?.('[data-local-path], [data-relative-path]');
          if (!target || !event.currentTarget.contains(target) || document.getSelection()?.toString()) return;
          event.preventDefault();
          event.stopPropagation();
          void activate(target);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const target = event.target as Element;
          if (!target.matches?.('[data-local-path], [data-relative-path]')) return;
          event.preventDefault();
          event.stopPropagation();
          void activate(target);
        }}
      >
        {children}
        {choice && (
          <dialog
            ref={dialog}
            className="native-dialog reply-path-dialog"
            aria-label="选择要打开的位置"
            onCancel={dismiss}
            onClick={(event) => {
              if (event.target === event.currentTarget) dismiss();
            }}
          >
            <div className="dialog-inner">
              <div className="dialog-title">
                <h2>选择要打开的位置</h2>
                <button type="button" className="icon-button" aria-label="关闭位置选择" onClick={dismiss}>
                  <X size={18} />
                </button>
              </div>
              <p>{choice.name}</p>
              {choice.truncated && <p>搜索范围较大，以下是部分结果；也可以使用更完整的路径。</p>}
              <div className="reply-path-options">
                {choice.paths.map((path) => (
                  <button
                    type="button"
                    className="button secondary"
                    key={path}
                    onClick={() => {
                      dismiss();
                      const request = sequence.current;
                      void open(path, choice.editor).catch((error) => {
                        if (sequence.current === request)
                          notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
                      });
                    }}
                  >
                    {path}
                  </button>
                ))}
              </div>
            </div>
          </dialog>
        )}
      </div>
    </ProjectPaths.Provider>
  );
}
