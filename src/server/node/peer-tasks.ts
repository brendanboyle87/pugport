import { setTimeout as sleep } from 'node:timers/promises';
import type { ExternalTasks } from '../external-tasks.ts';
import type { WorkspaceStore } from '../workspace-store.ts';
import { DesktopClosed, DesktopUncertain, type DesktopApp, type DesktopResult } from './desktop-app.ts';
import {
  maxResultLength,
  peerTaskProgressSchema,
  settledStatuses,
  peerRequestKeepMs,
  maxPeerRequests,
  maxPeerCancelTombstones,
  type PeerTaskResult,
  type PeerTaskStatus,
} from './peer-protocol.ts';
import { collectReturnFiles, nodeReceivedFolder, stripSendFileLines, type RecordedPeerFile } from './peer-files.ts';
import { exportPeerRepo, findPeerRepo, peerRepoBusy, withPeerRepo, type TaskRepo } from './peer-repos.ts';

export type PeerDispatch = {
  task: string;
  title?: string;
  projectPath?: string;
  write: boolean;
  untrusted: boolean;
  /** Shown on the node as who sent it, e.g. "设备 · Alex 的电脑". */
  caller: string;
  requestId?: string;
};

/** What the peer API needs from the node's task service; tests pass a fake. */
export type PeerTaskRunner = {
  dispatch(input: PeerDispatch, peerId: string): Promise<{ taskId: string; status: string }>;
  lookup(requestId: string, peerId: string): Promise<string | undefined>;
  /** Durably block a late dispatch before waiting for any dispatch already in progress. */
  cancelRequest(requestId: string, peerId: string): Promise<string | undefined>;
  /** The peer that created the task; a peer may only look at or stop its own. */
  owner(taskId: string): string | undefined;
  status(taskId: string): PeerTaskStatus | undefined;
  result(taskId: string, waitSeconds: number, signal?: AbortSignal): Promise<PeerTaskResult | undefined>;
  cancel(taskId: string): boolean;
  file?(taskId: string, fileId: string): RecordedPeerFile | undefined;
};

type RecordStore = Pick<WorkspaceStore, 'save' | 'get' | 'entries' | 'deleteRecord' | 'saveExpiring'>;
type RequestRecord = { taskId?: string; status: string; recordedAt?: number; cancelled?: boolean };
/** This dispatch was refused; an earlier attempt with the same id may still be in flight. */
export class PeerRequestNotSent extends Error {}
/** No tombstone was stored; the sender must retain its unknown outcome and occupied slot. */
export class PeerCancelUnconfirmed extends Error {}
const cancelKind = 'peer-request-cancel';
const ownerKind = 'peer-task';
const clip = (text: string | undefined) => (text === undefined ? undefined : text.slice(0, maxResultLength));
type TaskRecord = {
  repo?: TaskRepo;
  peerId: string;
  untrusted?: boolean;
  /** Handed to the desktop app on this computer, under the desktop's task id. */
  desktop?: boolean;
  /** A forwarded task's status when it was handed over, then once it ended. */
  status?: PeerTaskStatus;
  files?: RecordedPeerFile[];
  result?: PeerTaskResult;
  workflowId?: string;
};
const sendFileHint =
  "\n\nTo send a file back to the user's other computer, put a whole line in your final answer:\nPUGPORT_SEND_FILE: <absolute path on this computer>";
const deviceWorkHint =
  "\n\nThis is the owner's own computer, and they asked you to do this work. Download, install, and configure what they requested yourself instead of handing back manual steps.\nIf a step needs an administrator password (sudo -n true fails, or macOS shows a password dialog), do not wait on the prompt. Finish everything else and end with the exact command(s) the owner should run; put the same commands in the summary of your result line too.\nFor steps that can only be done in a GUI, say exactly what to click.";
const missing = '设备上的 PugPort 桌面版里已经没有这条任务，任务没有重跑。';
const waitingForDesktop = '设备上的 PugPort 桌面版已关闭。这条任务还没开始，会在它下次打开时运行。';
/** The desktop's external-task API takes at most this much task text. */
const maxDesktopTask = 50_000;

/**
 * Peer tasks are ordinary external tasks on the node: a conversation of their own, routed by the node's own quota.
 * While the PugPort desktop app runs on the same computer they go to it instead, so they use its accounts and show up
 * in its history. Which peer sent each one is kept beside it, so a peer never sees another's tasks.
 */
export function externalTaskRunner(
  tasks: ExternalTasks,
  store: RecordStore,
  desktop?: DesktopApp,
  options: { retryMs?: number; now?: () => number; maxRequestsPerPeer?: number } = {},
): PeerTaskRunner {
  const dispatching = new Map<string, Promise<{ taskId: string; status: string }>>();
  const finalizing = new Map<string, Promise<PeerTaskResult>>();
  // Forwarded tasks: the desktop's latest status, refreshed in the background each time a peer looks.
  const live = new Map<string, PeerTaskStatus>();
  const refreshing = new Set<string>();
  const now = options.now ?? Date.now;
  const requestRecord = (key: string) => {
    const admitted = store.get<RequestRecord>('peer-request', key);
    if (admitted) return admitted;
    const tombstone = store.get<RequestRecord>(cancelKind, key);
    return tombstone && now() - tombstone.recordedAt! <= peerRequestKeepMs ? tombstone : undefined;
  };
  const saveRequest = (key: string, peerId: string, value: RequestRecord) =>
    store.save('peer-request', key, peerId, { recordedAt: now(), ...requestRecord(key), ...value });
  const prune = (peerId: string) => {
    let count = 0;
    for (const { id, updatedAt, value } of store.entries<RequestRecord>('peer-request', peerId)) {
      if (now() - (value.recordedAt ?? Date.parse(updatedAt)) <= peerRequestKeepMs || dispatching.has(id)) {
        count++;
        continue;
      }
      const task = value.taskId && store.get<TaskRecord>(ownerKind, value.taskId);
      const status = value.taskId
        ? task &&
          (task.desktop
            ? (task.result?.status ?? live.get(value.taskId)?.status ?? task.status?.status)
            : tasks.status(value.taskId)?.status)
        : value.status;
      if (status && settledStatuses.has(status)) store.deleteRecord('peer-request', id);
      else count++;
    }
    return count;
  };
  const reserve = (key: string, peerId: string) => {
    const count = prune(peerId);
    if (!requestRecord(key) && count >= (options.maxRequestsPerPeer ?? maxPeerRequests))
      throw new PeerRequestNotSent('设备的请求记录已达上限，请稍后再发；这条没有发出去。');
  };
  const checkCancelled = (key: string | undefined) => {
    if (key && requestRecord(key)?.cancelled) throw new PeerRequestNotSent('这条请求已经取消，没有启动任务。');
  };

  const toDesktop = async (input: PeerDispatch, task: string, requestKey: string | undefined) => {
    // Too long for the desktop's API once the file hint is added: cutting it would drop the received-files list.
    if (task.length > maxDesktopTask) return undefined;
    const kind = await desktop?.probe();
    // An older desktop app would run it as an unknown outside caller, which must not write: those stay here.
    if (!kind || (kind === 'external' && input.write)) return undefined;
    checkCancelled(requestKey);
    return desktop!.dispatch(
      {
        task,
        caller: input.caller,
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        write: input.write,
        untrusted: input.untrusted,
      },
      kind,
    );
  };
  /** A forwarded task that can no longer finish: failed with the reason, never started again. */
  const ended = (taskId: string, error: string): PeerTaskResult => {
    const record = store.get<TaskRecord>(ownerKind, taskId);
    if (!record || record.result) return record?.result ?? { status: 'failed', error };
    const result = { status: 'failed', error };
    const status = { ...(live.get(taskId) ?? { taskId }), status: 'failed', error };
    live.delete(taskId);
    store.save(ownerKind, taskId, record.peerId, { ...record, status, result });
    return result;
  };
  /**
   * The desktop app is closed. A task it had started ended with it (it marks those interrupted when it opens again);
   * one still waiting stays in its queue and runs when it is back, so the node keeps waiting for that.
   */
  const closed = (taskId: string, error: DesktopClosed) => {
    const last = live.get(taskId) ?? store.get<TaskRecord>(ownerKind, taskId)?.status;
    if (last?.startedAt) return ended(taskId, error.message);
    live.set(taskId, { ...(last ?? { taskId, status: 'queued' }), note: waitingForDesktop });
    return undefined;
  };
  /** A task still waiting in a closed desktop app's queue would run when it opens: keep asking until it is back. */
  const stop = async (taskId: string, tries = 0): Promise<void> => {
    try {
      if (!(await desktop!.cancel(taskId))) ended(taskId, missing);
    } catch (error) {
      if (error instanceof DesktopClosed && tries < 2880)
        setTimeout(() => void stop(taskId, tries + 1), options.retryMs ?? 30_000).unref();
    }
  };
  const refresh = async (taskId: string) => {
    if (refreshing.has(taskId)) return;
    refreshing.add(taskId);
    try {
      const status = await desktop!.status(taskId);
      if (status) live.set(taskId, status);
      else ended(taskId, missing);
    } catch (error) {
      // A slow answer keeps the last status.
      if (error instanceof DesktopClosed) closed(taskId, error);
    } finally {
      refreshing.delete(taskId);
    }
  };
  /** Reads the files the task asked to send back, once, and keeps the answer for later polls. */
  const settle = (
    key: string,
    taskId: string,
    record: TaskRecord | undefined,
    outcome: Omit<DesktopResult, 'sendFiles'>,
    outputs: () => readonly string[],
    untrusted: boolean,
    keep: Partial<TaskRecord>,
  ) => {
    const pending = finalizing.get(key);
    if (pending) return pending;
    const finish = async (): Promise<PeerTaskResult> => {
      let files: RecordedPeerFile[] = [];
      let note = '';
      let bundle: string | undefined;
      if (record?.repo) {
        try {
          const exported = await exportPeerRepo(store, record.repo, record.peerId, taskId);
          bundle = exported.bundle;
          note += exported.notes.length ? `\n${exported.notes.join('\n')}` : '';
        } catch (error) {
          note += `\n项目改动未导出：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      try {
        const collected = await collectReturnFiles(
          [...(bundle ? [`PUGPORT_SEND_FILE: ${bundle}`] : []), ...outputs()],
          untrusted,
        );
        files = collected.files;
        if (collected.refused.length) note += `\n未发送的文件：\n${collected.refused.join('\n')}`;
      } catch (error) {
        note += `\n文件未发送：${error instanceof Error ? error.message : String(error)}`;
      }
      note = note.slice(0, 4000);
      const result: PeerTaskResult = {
        status: outcome.status,
        ...(outcome.result !== undefined || note
          ? { result: stripSendFileLines(outcome.result ?? '').slice(0, maxResultLength - note.length) + note }
          : {}),
        ...(outcome.error !== undefined ? { error: clip(stripSendFileLines(outcome.error)) } : {}),
        ...(files.length ? { files: files.map(({ id, name, size }) => ({ id, name, size })) } : {}),
      };
      store.save(ownerKind, taskId, record?.peerId ?? '', { ...record, ...keep, files, result });
      live.delete(taskId);
      return result;
    };
    const finishing = finish();
    finalizing.set(key, finishing);
    return finishing.finally(() => finalizing.delete(key));
  };

  const runner: PeerTaskRunner = {
    async cancelRequest(requestId, peerId) {
      const key = `${peerId}:${requestId}`;
      const admitted = store.get<RequestRecord>('peer-request', key);
      const cancelled = {
        status: admitted?.status ?? 'cancelled',
        cancelled: true,
        recordedAt: now(),
      };
      if (admitted) saveRequest(key, peerId, cancelled);
      else if (
        !store.saveExpiring(cancelKind, key, peerId, cancelled, {
          now: now(),
          keepMs: peerRequestKeepMs,
          limit: maxPeerCancelTombstones,
        })
      )
        throw new PeerCancelUnconfirmed('设备的取消记录已达上限，停止未确认；请稍后重试。');
      const pending = dispatching.get(key);
      if (pending) {
        try {
          await pending;
        } catch (error) {
          if (!(error instanceof PeerRequestNotSent)) throw error;
        }
      }
      return runner.lookup(requestId, peerId);
    },
    async lookup(requestId, peerId) {
      const key = `${peerId}:${requestId}`;
      const pending = dispatching.get(key);
      if (pending) await pending;
      // Reuse the durable dedupe record: a restart must not turn an uncertain dispatch into "not sent".
      const record = requestRecord(key);
      if (record?.taskId) return record.taskId;
      if (record && record.status !== 'failed' && record.status !== 'cancelled')
        throw new Error('上一次交付的结果不确定。请先检查这台设备上的任务，再重新发送。');
      return undefined;
    },
    async dispatch(input, peerId) {
      const requestKey = input.requestId ? `${peerId}:${input.requestId}` : undefined;
      if (requestKey) {
        reserve(requestKey, peerId);
        const pending = dispatching.get(requestKey);
        if (pending) return pending;
        const previous = requestRecord(requestKey);
        if (previous?.taskId) return { taskId: previous.taskId, status: previous.status };
        if (previous && previous.status !== 'failed' && previous.status !== 'cancelled')
          throw new Error('上一次交付的结果不确定。请先检查这台设备上的任务，再重新发送。');
        checkCancelled(requestKey);
        // Reserve before dispatch: after a crash an uncertain write must never be started a second time.
        saveRequest(requestKey, peerId, { status: 'dispatching' });
      }
      let repo = input.write && !input.untrusted ? findPeerRepo(store, input.projectPath) : undefined;
      const dispatch = async () => {
        const task = `${input.task}${input.write && !input.untrusted ? deviceWorkHint : ''}${sendFileHint}`;
        let forwarded: { taskId: string; status: string } | undefined;
        let created;
        try {
          // Re-read after acquiring the checkout lease: an import or dispatch may have just finished.
          if (repo) {
            repo = findPeerRepo(store, input.projectPath);
            if (!repo || repo.peerId !== peerId) throw new PeerRequestNotSent('没有这个项目。');
          }
          if (repo && peerRepoBusy(repo, runner)) throw new PeerRequestNotSent('这个项目在设备上的上一条任务还没结束');
          forwarded = await toDesktop(input, task, requestKey);
          if (!forwarded) checkCancelled(requestKey);
          created =
            forwarded ??
            (await tasks.dispatch({
              task,
              caller: input.caller,
              source: 'device',
              ...(input.title ? { title: `${input.caller} · ${input.title}` } : {}),
              ...(input.projectPath ? { projectPath: input.projectPath } : {}),
              ...(input.write ? { write: true } : { readOnly: true }),
              ...(input.untrusted ? { untrusted: true } : {}),
            }));
        } catch (error) {
          // One the desktop app may have taken stays reserved: it is never started a second time.
          if (requestKey && !(error instanceof DesktopUncertain))
            saveRequest(requestKey, peerId, { status: error instanceof PeerRequestNotSent ? 'cancelled' : 'failed' });
          throw error;
        }
        const reply = { taskId: created.taskId, status: created.status };
        if (repo)
          store.save('peer-repo', repo.path, peerId, { ...repo, lastTaskId: created.taskId, lastTaskAt: Date.now() });
        store.save(ownerKind, created.taskId, peerId, {
          peerId,
          ...(repo
            ? {
                repo: {
                  path: repo.path,
                  snapshot: repo.snapshot,
                  trip: repo.trip,
                  backFolder: nodeReceivedFolder(repo.peerName),
                },
              }
            : {}),
          untrusted: input.untrusted,
          ...(forwarded ? { desktop: true, status: reply } : {}),
        });
        if (requestKey) saveRequest(requestKey, peerId, reply);
        return reply;
      };
      const pending = repo ? withPeerRepo(store, repo.path, dispatch) : dispatch();
      if (requestKey) dispatching.set(requestKey, pending);
      try {
        return await pending;
      } finally {
        if (requestKey) dispatching.delete(requestKey);
      }
    },
    owner: (taskId) => store.get<{ peerId: string }>(ownerKind, taskId)?.peerId,
    status(taskId) {
      const record = store.get<TaskRecord>(ownerKind, taskId);
      if (record?.desktop && desktop) {
        if (record.result) return record.status;
        void refresh(taskId);
        return live.get(taskId) ?? record.status;
      }
      const status = tasks.status(taskId);
      if (!status) return undefined;
      const progress = peerTaskProgressSchema.safeParse(status.progress).data;
      // Only these fields leave the node (no conversation ids or local paths).
      return {
        taskId,
        status: status.status,
        phase: status.phase,
        ...(progress ? { progress } : {}),
        ...(status.executor ? { executor: status.executor } : {}),
        ...(status.model ? { model: status.model } : {}),
        ...(status.startedAt ? { startedAt: status.startedAt } : {}),
        ...(status.endedAt ? { endedAt: status.endedAt } : {}),
        ...('error' in status && status.error ? { error: status.error.slice(0, 4000) } : {}),
        ...('note' in status && status.note ? { note: status.note.slice(0, 4000) } : {}),
      };
    },
    async result(taskId, waitSeconds, signal) {
      const record = store.get<TaskRecord>(ownerKind, taskId);
      if (record?.desktop && desktop) {
        if (record.result) return record.result;
        let outcome: DesktopResult | undefined;
        try {
          outcome = await desktop.result(taskId, waitSeconds, signal);
        } catch (error) {
          const gone = error instanceof DesktopClosed ? closed(taskId, error) : undefined;
          if (gone) return gone;
          // Closed before it started, or a passing error: answer as a long poll that ran out, never as finished.
          if (!signal?.aborted) await sleep(waitSeconds * 1000, undefined, { signal }).catch(() => {});
          const last = live.get(taskId)?.status;
          return { status: last && !settledStatuses.has(last) ? last : 'running' };
        }
        if (!outcome) return ended(taskId, missing);
        if (!settledStatuses.has(outcome.status)) return { status: outcome.status };
        const { sendFiles, ...settled } = outcome;
        // The file lines of every step where the desktop sends them, so a file named before the final answer counts.
        return settle(
          taskId,
          taskId,
          record,
          settled,
          () => [...(sendFiles ?? []), settled.result ?? settled.error ?? ''],
          record.untrusted === true,
          { status: { ...(live.get(taskId) ?? { taskId }), status: settled.status } },
        );
      }
      const workflowId = tasks.find?.(taskId)?.id ?? taskId;
      if (record?.result && (record.workflowId ?? taskId) === workflowId) return record.result;
      const outcome = await tasks.result(taskId, waitSeconds, signal);
      if (!outcome) return undefined;
      if (!settledStatuses.has(outcome.status)) return { status: outcome.status };
      return settle(
        `${taskId}:${workflowId}`,
        taskId,
        record,
        {
          status: outcome.status,
          ...('result' in outcome ? { result: outcome.result ?? '' } : {}),
          ...('error' in outcome && outcome.error !== undefined ? { error: outcome.error } : {}),
        },
        () => [...tasks.fullOutputs(taskId), ...('result' in outcome && outcome.result ? [outcome.result] : [])],
        record?.untrusted === true || tasks.find?.(taskId)?.input.untrustedContent === true,
        { workflowId },
      );
    },
    file: (taskId, fileId) => store.get<TaskRecord>(ownerKind, taskId)?.files?.find((file) => file.id === fileId),
    cancel(taskId) {
      const record = store.get<TaskRecord>(ownerKind, taskId);
      if (!record?.desktop || !desktop) return tasks.cancel(taskId);
      if (!record.result) void stop(taskId);
      return true;
    },
  };
  return runner;
}
