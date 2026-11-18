import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Loader2, Unlink } from 'lucide-react';
import type { Api, Notice } from './Workspace';
import type { Settings } from '../shared/types';
import { saveSettings } from './settings-permissions';
import { assertCallerNarrowing } from '../shared/permission-change';
import { desktopBridge } from './desktop';
import { SettingsRow } from './SettingsRow';
import { confirmDialog } from './confirm-dialog';
import { withNames } from './i18n';

type Notify = (notice: Notice) => void;
type CallerPermissions = NonNullable<Settings['externalCallers']>;
const permissionTools: readonly (keyof CallerPermissions)[] = ['claude', 'codex', 'cursor', 'grok'];
const isPermissionTool = (id: string): id is keyof CallerPermissions => permissionTools.some((tool) => tool === id);
/** One tool as /api/external/connections describes it (src/server/mcp-connect.ts). */
export type ConnectTool = {
  id: string;
  name: string;
  detected: boolean;
  state: 'connected' | 'outdated' | 'absent';
  disabled?: true;
  method: 'command' | 'file' | 'copy';
  configPath: string;
  server: string;
  manual: string;
  note?: string;
};
type Connections = { server: string; tools: ConnectTool[]; snippet: string };
type Change = { tool: ConnectTool; changed: boolean; configPath: string; entry?: string; backup?: string };
const failure = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试。');

export function connectionStatus(tool: ConnectTool) {
  if (!tool.detected) return '这台电脑上没找到';
  if (tool.disabled) return withNames('在 {0} 里已关闭', [tool.name]);
  if (tool.state === 'connected') return '已接入';
  if (tool.state === 'outdated') return '已接入，需要更新';
  return '还没接入';
}

/**
 * 接入其他工具: adds PugPort's MCP server to Claude Code, Codex, Cursor or Grok CLI with one click, or
 * copies the command or configuration for doing it by hand. Hidden when the backend cannot list them.
 */
export function AgentConnect({
  api,
  notify,
  externalCallers,
}: {
  api: Api;
  notify: Notify;
  externalCallers?: Settings['externalCallers'];
}) {
  const [data, setData] = useState<Connections>();
  const [loadError, setLoadError] = useState('');
  const [permissions, setPermissions] = useState(externalCallers);
  useEffect(() => setPermissions(externalCallers), [externalCallers]);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<{ id: string; action: 'connect' | 'remove'; result: Change }>();
  const load = useCallback(async () => {
    try {
      const value = await api<Connections>('/api/external/connections', undefined, 'GET');
      if (!Array.isArray(value?.tools)) throw new Error('连接列表格式不正确。');
      setData(value);
      setLoadError('');
    } catch (error) {
      setLoadError(failure(error));
    }
  }, [api]);
  useEffect(() => {
    void Promise.resolve()
      .then(load)
      .catch(() => undefined);
  }, [load]);
  if (!data)
    return (
      <SettingsRow
        title="其他 AI 工具"
        className="agent-connect"
        status={loadError ? <span role="alert">读不到连接列表：{loadError}</span> : '正在加载…'}
        control={
          loadError && (
            <button type="button" className="button secondary tiny" onClick={() => void load()}>
              重试
            </button>
          )
        }
      />
    );
  const savePermission = async (id: keyof CallerPermissions, value: NonNullable<CallerPermissions[typeof id]>) => {
    if (busy) return;
    setBusy(`permission:${id}`);
    try {
      const next = { ...permissions, [id]: value };
      let widening = false;
      try {
        assertCallerNarrowing(permissions, next);
      } catch {
        widening = true;
      }
      if (widening) {
        const change = desktopBridge()?.changePermission;
        if (!change) throw new Error('请在桌面应用中修改权限。');
        if (!(await change({ kind: 'caller', tool: id, mode: value }))) return;
      } else await saveSettings(api, {}, { externalCallers: next });
      setPermissions(next);
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setBusy('');
    }
  };
  const copy = (text: string, message: string) =>
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => notify({ tone: 'success', message }))
      .catch(() => notify({ tone: 'error', message: '无法复制，请手动选择并复制。' }));
  const change = async (tool: ConnectTool, action: 'connect' | 'remove') => {
    if (busy) return;
    if (
      !(await confirmDialog({
        title: action === 'remove' ? `从 ${tool.name} 移除 PugPort？` : `在 ${tool.name} 接入 PugPort？`,
        points: [
          action === 'remove'
            ? `移除连接设置 ${tool.server}。`
            : tool.method === 'command'
              ? `运行命令：\n${tool.manual}`
              : `加入连接设置 ${tool.server}。`,
          `先备份配置文件：${tool.configPath}`,
        ],
        action: action === 'remove' ? '移除连接' : '接入 PugPort',
        tone: action === 'remove' ? 'danger' : undefined,
      }))
    )
      return;
    setBusy(`${action}:${tool.id}`);
    try {
      const result = await api<Change>(
        `/api/external/connections/${tool.id}`,
        action === 'connect' ? {} : undefined,
        action === 'connect' ? 'POST' : 'DELETE',
      );
      setDone({ id: tool.id, action, result });
      setData(
        (previous) =>
          previous && { ...previous, tools: previous.tools.map((item) => (item.id === tool.id ? result.tool : item)) },
      );
      notify({
        tone: 'success',
        message: !result.changed
          ? action === 'connect'
            ? `${tool.name} 已经接入，没有改动。`
            : `${tool.name} 里本来就没有 PugPort。`
          : action === 'connect'
            ? `已接入 ${tool.name}。重新打开 ${tool.name} 后就能用。`
            : `已从 ${tool.name} 移除 PugPort。`,
      });
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setBusy('');
    }
  };
  return (
    <SettingsRow
      title="其他 AI 工具"
      className="agent-connect"
      description="让 Claude Code、Codex、Cursor 等把任务交给 PugPort。"
      status={`${data.tools.filter((tool) => tool.state === 'connected').length} 个已接入`}
    >
      <p className="ext-section-note">
        接入后，这些工具可以把任务交给 PugPort、查看 PugPort 的对话；PugPort 自己使用它们不需要这一步。
      </p>
      {data.tools.map((tool) => {
        const file = tool.manual.trimStart().startsWith('{');
        const spinning = (action: string) => busy === `${action}:${tool.id}`;
        const result = done?.id === tool.id ? done : undefined;
        return (
          <div
            key={tool.id}
            data-settings-item={tool.id}
            tabIndex={-1}
            className={`external-agent-row ${tool.detected ? '' : 'off'}`}
          >
            <div className="external-agent-head">
              <span className="external-agent-name">
                <strong>{tool.name}</strong>
                <small className="agent-connect-status" translate={tool.disabled ? 'no' : undefined}>
                  {connectionStatus(tool)}
                </small>
              </span>
              <span className="external-agent-fields">
                {tool.detected && tool.state === 'connected' && isPermissionTool(tool.id) && (
                  <label className="agent-connect-permission">
                    <span>PugPort 任务权限</span>
                    <select
                      aria-label={`${tool.name} 的 PugPort 任务权限`}
                      value={permissions?.[tool.id] ?? 'inherit'}
                      disabled={!!busy}
                      onChange={(event) => {
                        if (isPermissionTool(tool.id))
                          void savePermission(
                            tool.id,
                            event.target.value as NonNullable<CallerPermissions[typeof tool.id]>,
                          );
                      }}
                    >
                      <option value="inherit">{`继承 ${tool.name}（默认）`}</option>
                      <option value="read-only">总是只读</option>
                      <option value="write">总是可写入（限其工作目录）</option>
                    </select>
                  </label>
                )}
                {tool.method !== 'copy' && tool.state !== 'connected' && (
                  <button
                    type="button"
                    className="button secondary tiny"
                    disabled={!!busy}
                    aria-label={`接入 ${tool.name}`}
                    onClick={() => void change(tool, 'connect')}
                  >
                    {spinning('connect') ? <Loader2 size={12} className="spinning" /> : <Link2 size={12} />}
                    {tool.disabled ? '重新打开' : tool.state === 'outdated' ? '更新' : '接入'}
                  </button>
                )}
                {tool.method !== 'copy' && tool.state !== 'absent' && (
                  <button
                    type="button"
                    className="button quiet tiny"
                    disabled={!!busy}
                    aria-label={`移除 ${tool.name}`}
                    onClick={() => void change(tool, 'remove')}
                  >
                    {spinning('remove') ? <Loader2 size={12} className="spinning" /> : <Unlink size={12} />}
                    移除
                  </button>
                )}
                <button
                  type="button"
                  className="button quiet tiny"
                  title={file ? `复制要加进 ${tool.configPath} 的配置` : '复制命令，在终端里运行'}
                  aria-label={`复制 ${tool.name} 的${file ? '配置' : '命令'}`}
                  onClick={() => copy(tool.manual, file ? '配置已复制。' : '命令已复制，粘贴到终端运行即可。')}
                >
                  <Copy size={12} />
                </button>
              </span>
            </div>
            {tool.note && <small className="ext-section-note">{tool.note}</small>}
            {result && (
              <details className="external-reply-diff" open>
                <summary>
                  {result.action === 'connect'
                    ? result.result.changed
                      ? `已写入 ${result.result.configPath}`
                      : `${result.result.configPath} 里已经有这一条`
                    : result.result.changed
                      ? `已从 ${result.result.configPath} 移除`
                      : `${result.result.configPath} 里本来就没有`}
                </summary>
                {result.result.entry && <pre>{result.result.entry}</pre>}
                {result.result.backup && <small>原文件已备份为 {result.result.backup}</small>}
              </details>
            )}
          </div>
        );
      })}
      <div className="connector-copy">
        <span className="ext-section-note" style={{ flex: 1, margin: 0 }}>
          其他支持 MCP 的工具：把这段配置加进它的 MCP 设置。
        </span>
        <button
          type="button"
          className="button secondary tiny"
          aria-label="复制配置"
          onClick={() => copy(data.snippet, '配置已复制，加进那个工具的 MCP 设置即可。')}
        >
          <Copy size={12} />
          复制配置
        </button>
      </div>
    </SettingsRow>
  );
}
