import { useEffect, useRef, useState } from 'react';
import type { Conversation, Project } from '../shared/types';
import type { Api, Notify } from './Workspace';
import { readableError } from './App';
import { SideSheet } from './SideSheet';
import { currentLocale, shownTitle, withNames } from './i18n';
import { confirmDialog } from './confirm-dialog';

export async function archiveConversation(api: Api, notify: Notify, item: Conversation, archived: boolean) {
  try {
    await api(`/api/conversations/${item.id}`, { archived }, 'PATCH');
    notify({
      tone: 'success',
      message: archived ? '已归档' : '已取消归档',
      ...(archived ? { action: { label: '撤销', run: () => archiveConversation(api, notify, item, false) } } : {}),
    });
    return true;
  } catch (error) {
    notify({ tone: 'error', message: readableError(error) });
    return false;
  }
}

export async function restoreConversation(api: Api, notify: Notify, item: Conversation) {
  try {
    await api(`/api/conversations/${item.id}/restore`, {});
    notify({ tone: 'success', message: '已恢复对话' });
    return true;
  } catch (error) {
    notify({ tone: 'error', message: readableError(error) });
    return false;
  }
}

export function ConversationArchive({
  kind,
  api,
  notify,
  projects,
  onChanged,
  onClose,
}: {
  kind: 'archived' | 'deleted';
  api: Api;
  notify: Notify;
  projects: Project[];
  onChanged?: () => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Conversation[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [bulk, setBulk] = useState(false);
  const [extraCleanup, setExtraCleanup] = useState<boolean>();
  const bulkPending = useRef(false);
  const title = kind === 'archived' ? '已归档' : '最近删除';
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void api<Conversation[]>(`/api/${kind}-conversations`, undefined, 'GET')
      .then((values) => {
        if (!cancelled) {
          setItems(values);
          setError('');
          if (kind === 'deleted' && !values.length) {
            setExtraCleanup(undefined);
            void api<{ purge: { olderCount: number; pendingCount?: number } }>(
              '/api/conversation-history',
              undefined,
              'GET',
            )
              .then(({ purge }) => {
                if (!cancelled) setExtraCleanup(!!(purge.olderCount || purge.pendingCount));
              })
              .catch((failure) => {
                if (!cancelled) setError(readableError(failure));
              });
          }
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(readableError(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [api, kind, revision]);
  async function restore(item: Conversation) {
    if (bulkPending.current || busy) return;
    setBusy(item.id);
    const ok =
      kind === 'archived'
        ? await archiveConversation(api, notify, item, false)
        : await restoreConversation(api, notify, item);
    if (ok) {
      setItems((values) => values?.filter((value) => value.id !== item.id));
      if (kind === 'deleted') setRevision((value) => value + 1);
      onChanged?.();
    }
    setBusy(undefined);
  }
  const report = (deleted: number, skipped: number, kept = 0, unsafe = 0) =>
    notify({
      tone: skipped || kept || unsafe ? 'info' : 'success',
      message: [
        withNames('已删除 {0} 个对话。', [String(deleted)]),
        ...(skipped ? [withNames('有 {0} 个对话仍在运行，已跳过。', [String(skipped)])] : []),
        ...(kept ? [withNames('有 {0} 个对话带有工作副本，已保留。', [String(kept)])] : []),
        ...(unsafe ? [withNames('有 {0} 个对话未能安全检查，已保留。', [String(unsafe)])] : []),
      ].join(' '),
    });
  /** Archived → Delete all moves chats to Recently deleted; Recently deleted → Empty removes them from PugPort. */
  async function clearAll() {
    if (bulkPending.current || busy) return;
    bulkPending.current = true;
    setBulk(true);
    let sent = false;
    try {
      if (kind === 'archived') {
        if (
          !(await confirmDialog({
            title: '删除全部 {0} 个已归档对话？',
            names: [String(items?.length ?? 0)],
            summary: '它们会移到「最近删除」，在那里仍可恢复。仍在运行的对话会跳过。',
            action: '全部删除',
            tone: 'danger',
          }))
        )
          return;
        sent = true;
        const result = await api<{ deleted: number; skipped: number }>('/api/archived-conversations/delete-all', {});
        report(result.deleted, result.skipped);
      } else {
        const { purge } = await api<{ purge: { count: number; olderCount: number; token: string } }>(
          '/api/conversation-history',
          undefined,
          'GET',
        );
        if (
          !(await confirmDialog({
            title: purge.olderCount
              ? '永久删除此列表中的 {0} 个对话，以及 {1} 个更早删除的对话？'
              : '永久删除此列表中的 {0} 个对话？',
            names: purge.olderCount ? [String(purge.count), String(purge.olderCount)] : [String(purge.count)],
            summary: 'PugPort 将不再保留这些对话，但各 AI 自己的应用或 CLI 可能保留记录。此操作无法撤销。',
            action: '清空',
            tone: 'danger',
          }))
        )
          return;
        sent = true;
        const result = await api<{ deleted: number; skipped: number; kept: number; unsafe: number }>(
          '/api/deleted-conversations/empty',
          { token: purge.token },
        );
        report(result.deleted, result.skipped, result.kept, result.unsafe);
      }
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    } finally {
      if (sent) {
        setRevision((value) => value + 1);
        onChanged?.();
      }
      bulkPending.current = false;
      setBulk(false);
    }
  }
  return (
    <SideSheet
      title={title}
      label={title}
      onClose={onClose}
      className="conversation-archive"
      actions={
        <button
          type="button"
          className={`button tiny ${kind === 'archived' ? 'danger' : 'secondary danger'}`}
          disabled={bulk || !!busy || !items || !!error || (!items.length && (kind === 'archived' || !extraCleanup))}
          onClick={() => void clearAll()}
        >
          {kind === 'archived' ? '全部删除' : '清空'}
        </button>
      }
    >
      {kind === 'deleted' && <p className="muted">这里显示最近 30 天删除的对话；更早删除的对话会保留，直到清空。</p>}
      {error ? (
        <p role="alert">{error}</p>
      ) : !items ? (
        <p role="status">加载中…</p>
      ) : !items.length ? (
        <p>暂无对话</p>
      ) : (
        items.map((item) => {
          const time = (kind === 'archived' ? item.archivedAt : item.deletedAt)!;
          return (
            <div className="removed-project" key={item.id}>
              <span>
                <strong title={shownTitle(item.title)} translate="no">
                  {shownTitle(item.title)}
                </strong>
                <small translate="no">{projects.find((project) => project.id === item.projectId)?.name}</small>
                <time dateTime={time}>{new Date(time).toLocaleString(currentLocale())}</time>
              </span>
              <button type="button" disabled={!!busy || bulk} onClick={() => void restore(item)}>
                {kind === 'archived' ? '取消归档' : '恢复'}
              </button>
            </div>
          );
        })
      )}
    </SideSheet>
  );
}
