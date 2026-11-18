import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { ProjectCliContext as Context, ProjectCliContextUpdate } from '../shared/project-cli-context';
import type { Api } from './Workspace';
import { desktopBridge } from './desktop';
import { SettingsGroup } from './SettingsRow';
import { useUiUpdateBlocker } from './ui-update-guard';
import { queryDraft, queryFromDraft, type QueryDraft } from './project-cli-context-draft';

type Props = {
  projectId: string;
  api: Api;
  notify?: (notice: { tone: 'success' | 'error' | 'info'; message: string }) => void;
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。');

export function ProjectCliContext({ projectId, api, notify }: Props) {
  const [saved, setSaved] = useState<Context>();
  const [memory, setMemory] = useState('');
  const [queries, setQueries] = useState<QueryDraft[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const pending = useRef(false);
  const dirty =
    !!saved &&
    (memory !== (saved.autoMemoryDirectory ?? '') ||
      JSON.stringify(queries) !== JSON.stringify(saved.sshQueries.map(queryDraft)));
  useUiUpdateBlocker(() => busy || dirty, '项目上下文草稿');
  const apply = (value: Context) => {
    setSaved(value);
    setMemory(value.autoMemoryDirectory ?? '');
    setQueries(value.sshQueries.map(queryDraft));
  };
  useEffect(() => {
    const abort = new AbortController();
    setSaved(undefined);
    setMemory('');
    setQueries([]);
    setError('');
    setLoading(true);
    void api<Context>(`/api/projects/${encodeURIComponent(projectId)}/cli-context`, undefined, 'GET', abort.signal)
      .then(
        (value) => {
          if (!abort.signal.aborted) apply(value);
        },
        (reason) => {
          if (!abort.signal.aborted) setError(errorText(reason));
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, projectId, attempt]);
  async function pickMemory() {
    const desktop = desktopBridge();
    if (!desktop || pending.current) return;
    const owner = projectId;
    pending.current = true;
    setBusy(true);
    try {
      const path = await desktop.pickDirectory();
      if (currentProject.current === owner && path) setMemory(path);
    } catch (reason) {
      if (currentProject.current === owner) setError(errorText(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!saved || pending.current) return;
    const owner = projectId;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const body: ProjectCliContextUpdate = {
        revision: saved.revision,
        autoMemoryDirectory: memory.trim() || null,
        sshQueries: queries.map(queryFromDraft),
      };
      const value = await api<Context>(`/api/projects/${encodeURIComponent(projectId)}/cli-context`, body, 'PUT');
      if (currentProject.current === owner) {
        apply(value);
        notify?.({ tone: 'success', message: '项目上下文授权已保存。' });
      }
    } catch (reason) {
      if (currentProject.current === owner) setError(errorText(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const change = (index: number, patch: Partial<QueryDraft>) =>
    setQueries((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <SettingsGroup
      title="项目上下文"
      description="只对这个项目生效。保存表示允许本项目使用所选记忆文件夹和下列固定远程查询。"
    >
      {loading && <p role="status">正在读取项目配置…</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {error && saved && (
        <button
          type="button"
          className="button small quiet"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          丢弃草稿并重新载入
        </button>
      )}
      {!saved && !loading && (
        <button className="button small" onClick={() => setAttempt((value) => value + 1)}>
          重新载入
        </button>
      )}
      {saved && (
        <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 16, minWidth: 0, display: 'grid', gap: 12 }}>
          <label className="field">
            Claude 自动记忆文件夹
            <input
              aria-label="Claude 自动记忆文件夹"
              value={memory}
              onChange={(event) => setMemory(event.target.value)}
              placeholder="未授权共享记忆文件夹"
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {desktopBridge() && (
              <button type="button" className="button small quiet" onClick={() => void pickMemory()}>
                <FolderOpen size={14} />
                选择文件夹
              </button>
            )}
            {memory && (
              <button type="button" className="button small quiet" onClick={() => setMemory('')}>
                移除授权
              </button>
            )}
          </div>
          <p className="muted">仅传递这个文件夹的位置。不会复制 settings.local.json 中的环境、钩子、权限或凭证。</p>
          <h4>用户授权的固定远程查询</h4>
          <p className="muted">
            使用本机已有的 SSH 身份和已信任主机。AI
            只能按名称运行已保存的查询或作业，作业参数必须符合你定义的类型。命令是否修改远端内容取决于你保存的命令；需要远端使用
            POSIX 兼容命令解释器。请勿把密码或密钥写入参数。
          </p>
          {queries.map((query, index) => (
            <div className="settings-row" key={index} style={{ display: 'grid', gap: 12, padding: 12 }}>
              <label className="field">
                查询名称
                <input
                  aria-label={`查询名称 ${index + 1}`}
                  value={query.name}
                  onChange={(event) => change(index, { name: event.target.value })}
                  placeholder="service-status"
                />
              </label>
              <label className="field">
                SSH 主机别名
                <input
                  aria-label={`SSH 主机别名 ${index + 1}`}
                  value={query.host}
                  onChange={(event) => change(index, { host: event.target.value })}
                  placeholder="my-server"
                />
              </label>
              <label className="field">
                固定命令与参数（每行一项）
                <textarea
                  aria-label={`固定命令与参数 ${index + 1}`}
                  rows={4}
                  value={query.arguments}
                  onChange={(event) => change(index, { arguments: event.target.value })}
                  placeholder={'systemctl\nis-active\nmy-service'}
                />
              </label>
              <label className="field">
                超时秒数
                <input
                  aria-label={`超时秒数 ${index + 1}`}
                  type="number"
                  min={1}
                  max={query.background ? 14400 : 120}
                  value={query.timeoutSeconds ?? 30}
                  onChange={(event) => change(index, { timeoutSeconds: Number(event.target.value) })}
                />
              </label>
              <details>
                <summary>作业选项</summary>
                <div style={{ display: 'grid', gap: 12, paddingTop: 12 }}>
                  <label className="field">
                    参数类型（每行名称=类型）
                    <textarea
                      rows={3}
                      value={query.parameters}
                      onChange={(event) => change(index, { parameters: event.target.value })}
                      placeholder={'sha=sha\nbranch=branch'}
                    />
                  </label>
                  <p className="muted">
                    类型可填 sha、branch、relpath、word、int。命令中用 &#123;名称&#125; 单独占一行，首行不能用参数。
                  </p>
                  <label className="field">
                    运行目录
                    <input
                      value={query.cwd ?? ''}
                      placeholder="/srv/project"
                      onChange={(event) => change(index, { cwd: event.target.value || undefined })}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={!!query.background}
                      onChange={(event) => change(index, { background: event.target.checked || undefined })}
                    />
                    后台运行
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={!!query.readOnly}
                      onChange={(event) => change(index, { readOnly: event.target.checked || undefined })}
                    />
                    只读作业
                  </label>
                  <p className="muted">只读作业允许只读调用方运行。请确保命令不会修改远端内容。</p>
                  <label className="field">
                    推送到裸仓库
                    <input
                      value={query.repository}
                      placeholder="~/project.git"
                      onChange={(event) => change(index, { repository: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    推送引用（每行一项）
                    <textarea
                      rows={2}
                      value={query.refs}
                      placeholder="{sha}:refs/heads/job"
                      onChange={(event) => change(index, { refs: event.target.value })}
                    />
                  </label>
                  <p className="muted">留空则不推送；推送需要后台运行。每行填写来源:目标。</p>
                </div>
              </details>
              <button
                type="button"
                className="button small quiet"
                onClick={() => setQueries((items) => items.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
                移除查询
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="button small quiet"
              disabled={queries.length >= 20}
              onClick={() =>
                setQueries((items) => [...items, queryDraft({ name: '', host: '', argv: [''], timeoutSeconds: 30 })])
              }
            >
              <Plus size={14} />
              添加固定查询
            </button>
            <button type="button" className="button small" disabled={!dirty} onClick={() => void save()}>
              {busy ? '正在保存…' : '授权并保存'}
            </button>
            <button type="button" className="button small quiet" disabled={!dirty} onClick={() => apply(saved)}>
              撤销未保存修改
            </button>
          </div>
        </fieldset>
      )}
    </SettingsGroup>
  );
}
