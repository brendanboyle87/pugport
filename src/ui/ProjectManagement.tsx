import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/types';
import type { ProjectPurgePreview, ProjectPurgeResult } from '../shared/project-data';
import { confirmDialog } from './confirm-dialog';
import type { MenuItem } from './DesktopFeatures';
import type { Api, Notice } from './Workspace';
import { withNames } from './i18n';
import { SideSheet } from './SideSheet';

export async function confirmProjectRemoval(): Promise<boolean> {
  return confirmDialog({
    title: '从 PugPort 移除这个项目？硬盘上的文件不会被删除。',
    summary: '项目和对话会从列表隐藏，可在已移除的项目中恢复。',
    action: '从列表移除',
    tone: 'danger',
  });
}

export function projectManagementItems(rename: () => void, remove: () => void): MenuItem[] {
  return [
    { label: '重命名', icon: <Pencil size={14} />, onSelect: rename },
    { label: '从列表移除', icon: <Trash2 size={14} />, danger: true, onSelect: remove },
  ];
}

export function MissingProjectFolder({
  onRemove,
  onMoveToChats,
  movingToChats = false,
}: {
  onRemove: () => void;
  onMoveToChats?: () => void;
  movingToChats?: boolean;
}) {
  return (
    <div className="project-missing">
      <span>文件夹已不存在</span>
      <div className="project-missing-actions">
        {onMoveToChats && (
          <button type="button" onClick={onMoveToChats} disabled={movingToChats}>
            移到对话
          </button>
        )}
        <button type="button" onClick={onRemove}>
          从列表移除
        </button>
      </div>
    </div>
  );
}

export function RemovedProjects({
  projects,
  api,
  reload,
  notify,
}: {
  projects: Project[];
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  return (
    <section id="settings-removed-projects" className="panel settings-section removed-projects-panel">
      <div className="section-title">
        <h2>
          已移除的项目 <small>{projects.length}</small>
        </h2>
      </div>
      <p className="quiet-text">
        可恢复到项目列表，或永久清空 PugPort 保存的数据。关联的原项目文件夹会保留，应用自建的聊天目录会一并清理。
      </p>
      {projects.length ? (
        <div className="removed-projects-list">
          {projects.map((project) => (
            <RemovedProjectRow key={project.id} project={project} api={api} reload={reload} notify={notify} />
          ))}
        </div>
      ) : (
        <p className="quiet-text">没有已移除的项目。</p>
      )}
    </section>
  );
}

/** Wraps the list unchanged; Clear list only hides entries, nothing is deleted. */
export function RemovedProjectsSheet({
  projects,
  api,
  reload,
  notify,
  onClose,
}: {
  projects: Project[];
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function clear() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (
        !(await confirmDialog({
          title: '清空列表中的 {0} 个已移除项目？',
          names: [String(projects.length)],
          summary: '只是隐藏这些条目，不会删除任何数据。之后移除的项目仍会显示，未完成清空的项目会保留。',
          action: '清空列表',
        }))
      )
        return;
      await api('/api/removed-projects/clear', {});
      await reload();
      notify({ tone: 'success', message: '已清空列表。' });
      onClose();
    } catch (error) {
      notify({ tone: 'error', message: failureText(error) });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <SideSheet
      title="已移除的项目"
      label="已移除的项目"
      onClose={onClose}
      actions={
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy || !projects.length}
          onClick={() => void clear()}
        >
          清空列表
        </button>
      }
    >
      <RemovedProjects projects={projects} api={api} reload={reload} notify={notify} />
    </SideSheet>
  );
}

const fileBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 * 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function RemovedProjectRow({
  project,
  api,
  reload,
  notify,
}: {
  project: Project;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  const [preview, setPreview] = useState<ProjectPurgePreview>();
  const [busy, setBusy] = useState<'preview' | 'restore' | 'purge' | 'refresh'>();
  const [failure, setFailure] = useState('');
  const [finished, setFinished] = useState<'restore' | 'purge'>();
  const alive = useRef(true),
    locked = useRef(false),
    request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  async function inspect() {
    if (locked.current || !alive.current) return;
    locked.current = true;
    setBusy('preview');
    setFailure('');
    const abort = new AbortController();
    request.current = abort;
    try {
      const value = await api<ProjectPurgePreview>(
        `/api/projects/${encodeURIComponent(project.id)}/purge-preview`,
        undefined,
        'GET',
        abort.signal,
      );
      if (alive.current) setPreview(value);
    } catch (error) {
      if (alive.current) {
        setPreview(undefined);
        setFailure(failureText(error));
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(undefined);
    }
  }
  async function updateList() {
    try {
      await reload();
    } catch (error) {
      if (alive.current) setFailure(withNames('操作已完成，但列表刷新失败：{0}', [failureText(error)]));
    }
  }
  async function act(kind: 'restore' | 'purge') {
    if (locked.current || !preview || finished || (kind === 'restore' ? preview.partial : !preview.canPurge)) return;
    locked.current = true;
    setBusy(kind);
    setFailure('');
    try {
      if (
        kind === 'purge' &&
        !(await confirmDialog({
          title: '永久清空「{0}」在 PugPort 中的数据？',
          names: [project.name],
          summary: preview.managedWorkspacePath
            ? '此操作无法撤销。应用自建的聊天目录也会永久删除。'
            : '此操作无法撤销。关联的原项目文件夹会保留。',
          points: [
            withNames('{0} 个对话、{1} 个附件记录、{2} 个应用管理文件。', [
              String(preview.conversations),
              String(preview.attachments),
              String(preview.managedFiles),
            ]),
            withNames('预计释放文件空间：{0}。共享文件会按实际引用保留。', [fileBytes(preview.managedBytes)]),
            ...(preview.preservedProjectPath ? [withNames('保留原项目目录：{0}', [preview.preservedProjectPath])] : []),
            ...(preview.managedWorkspacePath
              ? [withNames('应用自建的聊天目录将一并清空：{0}', [preview.managedWorkspacePath])]
              : []),
            ...((preview.scheduledTasks ?? 0) > 0
              ? [withNames('同时暂停 {0} 个相关定时任务，保留其配置和历史。', [String(preview.scheduledTasks)])]
              : []),
          ],
          action: '永久清空',
          tone: 'danger',
        }))
      )
        return;
      if (!alive.current) return;
      if (kind === 'restore') {
        await api(`/api/projects/${encodeURIComponent(project.id)}/restore`, {});
        if (alive.current) notify({ tone: 'success', message: '项目已恢复。' });
      } else {
        const result = await api<ProjectPurgeResult>(`/api/projects/${encodeURIComponent(project.id)}/purge`, {
          token: preview.token,
        });
        if (alive.current)
          notify({
            tone: result.warnings?.length ? 'info' : 'success',
            message:
              withNames('已永久清空 PugPort 保存的数据，释放文件空间 {0}。', [fileBytes(result.freedBytes)]) +
              (preview.preservedProjectPath ? ' 原项目文件夹已保留。' : '') +
              (result.scheduledTasks ? withNames('已暂停 {0} 个相关定时任务。', [String(result.scheduledTasks)]) : '') +
              (result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''),
          });
      }
      if (!alive.current) return;
      setFinished(kind);
      await updateList();
    } catch (error) {
      if (alive.current) {
        setFailure(failureText(error));
        setPreview(undefined);
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(undefined);
    }
  }
  return (
    <details
      className="removed-project-settings-row"
      onToggle={(event) => {
        if (event.currentTarget.open && !preview && !finished) void inspect();
      }}
    >
      <summary>
        <span>{project.name}</span>
        <small title={project.path}>{project.path}</small>
      </summary>
      <div className="removed-project-settings-body" aria-busy={!!busy}>
        {busy === 'preview' && <p role="status">正在核对保存的数据…</p>}
        {failure && (
          <p className="notice error" role="alert">
            {failure}
          </p>
        )}
        {finished ? (
          <>
            <p role="status">{finished === 'restore' ? '项目已恢复。' : 'PugPort 保存的数据已永久清空。'}</p>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => {
                if (locked.current) return;
                locked.current = true;
                setBusy('refresh');
                void updateList().finally(() => {
                  locked.current = false;
                  if (alive.current) setBusy(undefined);
                });
              }}
            >
              刷新列表
            </button>
          </>
        ) : (
          <>
            {preview && (
              <>
                <p className="quiet-text">
                  {withNames('{0} 个对话 · {1} 个附件记录 · {2} 个应用管理文件', [
                    String(preview.conversations),
                    String(preview.attachments),
                    String(preview.managedFiles),
                  ])}
                  <br />
                  {withNames('预计释放文件空间 {0}', [fileBytes(preview.managedBytes)])}
                  {!!preview.scheduledTasks && (
                    <>
                      <br />
                      {withNames('将暂停 {0} 个相关定时任务。', [String(preview.scheduledTasks)])}
                    </>
                  )}
                </p>
                {preview.partial && <p role="status">上次清空尚未完成，只能重试清空。</p>}
                {!preview.canPurge && <p role="status">{preview.blockedReason || '当前不能清空，请稍后重新检查。'}</p>}
              </>
            )}
            <div className="removed-project-settings-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !preview || preview.partial}
                onClick={() => void act('restore')}
              >
                恢复
              </button>
              <button
                type="button"
                className="button danger"
                disabled={!!busy || !preview?.canPurge}
                onClick={() => void act('purge')}
              >
                {preview?.partial ? '重试清空' : '永久清空'}
              </button>
              <button type="button" className="button quiet" disabled={!!busy} onClick={() => void inspect()}>
                重新检查
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
