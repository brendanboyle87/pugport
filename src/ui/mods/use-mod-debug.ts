import { useEffect, useMemo, useState } from 'react';
import type { Conversation, RunRecord, Workflow } from '../../shared/types';
import type { Api } from '../Workspace';
import { returnUnsentModDiagnostics, takeUnsentModDiagnostics } from './mod-debug-store';

/** The parts of a Mods author workspace record the Debug menu shows. */
export type LocalModBuild = {
  id: string;
  modId?: string;
  latestVersion?: string;
  lastLoad?: { ok: boolean; warnings?: string[]; issues?: string[]; needsApproval?: string[] };
};

/** The chat's workspace record when its bound Mod is the one built there (a Local build); else nothing. */
export function useLocalModBuild(
  api: Api,
  conversation: Conversation | undefined,
  runs: readonly RunRecord[],
  workflows: readonly Workflow[],
) {
  const id = conversation?.modWorkspaceId;
  const modId = conversation?.modeBinding?.modeId;
  const [build, setBuild] = useState<LocalModBuild>();
  const runIds = useMemo(() => new Set(workflows.flatMap((workflow) => workflow.runIds)), [workflows]);
  const loaded = runs
    .filter((run) => runIds.has(run.id))
    .flatMap((run) =>
      run.events
        .filter(
          (event) => event.type === 'tool' && event.data?.tool === 'mod_load' && event.data.status !== 'inProgress',
        )
        .map((event) => `${run.id}:${event.seq ?? event.at}`),
    )
    .join('|');
  useEffect(() => {
    if (!id || !modId) {
      setBuild(undefined);
      return;
    }
    let current = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await api<LocalModBuild>(`/api/mod-workspaces/${encodeURIComponent(id)}`, undefined, 'GET');
        if (current) setBuild(value);
      } catch {
        if (current) setBuild(undefined);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [api, id, modId, loaded]);
  return build && build.modId === modId ? build : undefined;
}

/** Where a Mods author chat builds: a folder name for the mode menu, undefined for the default area. */
export function useModWorkspaceFolder(api: Api, conversation: Conversation | undefined) {
  const id = conversation?.workMode === 'mods-author' ? conversation.modWorkspaceId : undefined;
  const [path, setPath] = useState<string>();
  useEffect(() => {
    if (!id) {
      setPath(undefined);
      return;
    }
    let current = true;
    api<{ path: string }>(`/api/mod-workspaces/${encodeURIComponent(id)}`, undefined, 'GET')
      .then((value) => current && setPath(value.path))
      .catch(() => current && setPath(undefined));
    return () => {
      current = false;
    };
  }, [api, id]);
  // The default <dataDir>/mods-workspace/<id> folder reads as the area, not a random id.
  if (!path || /[\\/]mods-workspace[\\/][0-9a-f]{10}$/.test(path)) return undefined;
  return path.split(/[\\/]/).filter(Boolean).pop();
}

/** Sends the frame's diagnostics to the workspace in small batches, so the next turn and mod_debug see them. */
export function useModDiagnosticsUpload(api: Api, workspaceId: string | undefined, conversationId: string | undefined) {
  useEffect(() => {
    if (!workspaceId || !conversationId) return;
    let busy = false;
    const flush = async () => {
      if (busy) return;
      const entries = takeUnsentModDiagnostics(conversationId);
      if (!entries.length) return;
      busy = true;
      // 50 lines stay under the route's 64 KiB body limit even when every character is CJK.
      let sent = 0;
      try {
        for (; sent < entries.length; sent += 50)
          await api(`/api/mod-workspaces/${encodeURIComponent(workspaceId)}/diagnostics`, {
            entries: entries.slice(sent, sent + 50),
          });
      } catch {
        returnUnsentModDiagnostics(conversationId, entries.slice(sent));
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void flush(), 2000);
    return () => {
      clearInterval(timer);
      void flush();
    };
  }, [api, workspaceId, conversationId]);
}
