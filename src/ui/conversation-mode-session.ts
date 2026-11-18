import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Conversation } from '../shared/types';
import {
  type ConversationModeView,
  type ConversationModesView,
  type modRunRequestSchema,
} from '../shared/conversation-modes';
type ModRunRequest = z.infer<typeof modRunRequestSchema>;
import type { Api } from './Workspace';
import { modCatalogMetadataSchema } from '../shared/mods-manifest';

const fields = modCatalogMetadataSchema.shape;
export const catalogResponse = z.object({
  catalog: z.array(modCatalogMetadataSchema.omit({ cover: true }).extend({ compatible: z.literal(true) })).max(200),
  installed: z.array(z.object({ modeId: fields.id, version: fields.version, installedAt: z.string() })).max(200),
});

/** Mode metadata is local and lazy; ordinary message submission never waits for it. */
export function useConversationMode(api: Api, conversation?: Conversation) {
  const id = conversation?.id;
  const current = useRef(id);
  current.current = id;
  const currentBinding = useRef(conversation?.modeBinding);
  currentBinding.current = conversation?.modeBinding;
  const alive = useRef(true);
  const [loaded, setLoaded] = useState<{ id: string; view: ConversationModeView }>();
  const latest = useRef(loaded);
  latest.current = loaded;
  const [catalog, setCatalog] = useState<ConversationModesView>();
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const mutation = useRef(false);
  const [failure, setFailure] = useState<{ id?: string; text: string }>();
  const request = useRef(0);
  const webRequest = useRef(0);
  const webApplied = useRef(0);
  function remember(captured: string, view: ConversationModeView) {
    const previous = latest.current;
    if (
      previous?.id === captured &&
      previous.view.instance?.id === view.instance?.id &&
      (previous.view.instance?.revision ?? -1) > (view.instance?.revision ?? -1)
    )
      return;
    const value = { id: captured, view };
    latest.current = value;
    setLoaded(value);
    setFailure(undefined);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current++;
    };
  }, []);
  // A finished Mod model run changes saved state on the server; read the view again.
  const bindingKey = JSON.stringify([
    conversation?.modeBinding,
    conversation?.pendingModeBinding,
    conversation?.modeRunsAt,
  ]);
  useEffect(() => {
    const ticket = ++request.current;
    if (!id || (!conversation?.modeBinding && !conversation?.pendingModeBinding)) {
      setLoaded(undefined);
      return;
    }
    const abort = new AbortController();
    void api<ConversationModeView>(`/api/conversations/${encodeURIComponent(id)}/mode`, undefined, 'GET', abort.signal)
      .then((view) => {
        if (alive.current && ticket === request.current && current.current === id) {
          remember(id, view);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && alive.current && ticket === request.current)
          setFailure({ id, text: String(error instanceof Error ? error.message : error) });
      });
    return () => abort.abort();
  }, [api, id, bindingKey]);

  async function loadCatalog() {
    if (loading) return;
    setLoading(true);
    try {
      const value = catalogResponse.safeParse(await api<unknown>('/api/modes', undefined, 'GET'));
      if (!value.success) throw new Error('Invalid mode catalog response');
      if (alive.current) setCatalog(value.data);
    } catch (error) {
      if (alive.current)
        setFailure({ id: current.current, text: String(error instanceof Error ? error.message : error) });
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  async function mutate(path: string, body: unknown, method = 'POST') {
    if (!id || mutation.current) throw new Error('请等待模式操作完成。');
    const captured = id;
    mutation.current = true;
    setBusyId(captured);
    // An older GET cannot overwrite a just-saved revision.
    const ticket = ++request.current;
    try {
      const view = await api<ConversationModeView>(
        `/api/conversations/${encodeURIComponent(captured)}/${path}`,
        body,
        method,
      );
      if (path === 'mode-actions' && (!alive.current || current.current !== captured || ticket !== request.current))
        throw new Error('会话模式已变化，请重新操作。');
      if (alive.current && current.current === captured && ticket === request.current) {
        remember(captured, view);
      }
      return view;
    } catch (error) {
      if (alive.current && current.current === captured && ticket === request.current)
        setFailure({ id: captured, text: String(error instanceof Error ? error.message : error) });
      throw error;
    } finally {
      mutation.current = false;
      if (alive.current) setBusyId(undefined);
    }
  }

  // Web slots share revisions, not the form's single-operation button lock.
  async function webState(write?: { instanceId: string; expectedRevision: number; values: Record<string, string> }) {
    const captured = id;
    const binding = conversation?.modeBinding;
    const matches = (value: typeof binding) =>
      !!binding &&
      value?.instanceId === binding.instanceId &&
      value.modeId === binding.modeId &&
      value.version === binding.version;
    const available = () =>
      alive.current &&
      !!captured &&
      current.current === captured &&
      matches(currentBinding.current) &&
      latest.current?.id === captured &&
      matches(latest.current.view.binding ?? undefined) &&
      latest.current.view.installed;
    if (!available() || (write && write.instanceId !== binding!.instanceId)) throw new Error('Mod is unavailable.');
    const ticket = ++webRequest.current;
    const view = await api<ConversationModeView>(
      `/api/conversations/${encodeURIComponent(captured!)}/${write ? 'mode-actions' : 'mode'}`,
      write
        ? {
            instanceId: write.instanceId,
            expectedRevision: write.expectedRevision,
            action: { type: 'save', values: write.values },
          }
        : undefined,
      write ? 'POST' : 'GET',
    );
    if (
      !available() ||
      !matches(view.binding ?? undefined) ||
      view.instance?.id !== binding!.instanceId ||
      view.instance.conversationId !== captured ||
      view.instance.modeId !== binding!.modeId ||
      view.instance.version !== binding!.version ||
      !view.installed
    )
      throw new Error('Mod is unavailable.');
    const revision = latest.current?.view.instance?.revision ?? -1;
    if (view.instance.revision > revision || (view.instance.revision === revision && ticket >= webApplied.current)) {
      webApplied.current = ticket;
      remember(captured!, view);
    }
    return view;
  }

  return {
    view: loaded && loaded.id === id ? loaded.view : undefined,
    catalog,
    loading,
    busy: busyId === id && !!id,
    error: failure?.id === id ? failure?.text : undefined,
    loadCatalog,
    reload: () => mutate('mode', undefined, 'GET'),
    select: (modeId: string | null, version?: string) =>
      mutate('mode', { modeId, ...(modeId && version ? { version } : {}) }, 'PUT'),
    setHidden: async (hidden: boolean) => {
      if (!id || mutation.current) throw new Error('请等待模式操作完成。');
      const captured = id;
      mutation.current = true;
      setBusyId(captured);
      try {
        const updated = await api<Conversation>(
          `/api/conversations/${encodeURIComponent(captured)}/mode/visibility`,
          { hidden },
          'PUT',
        );
        if (alive.current && current.current === captured) setFailure(undefined);
        return updated;
      } catch (error) {
        if (alive.current && current.current === captured)
          setFailure({ id: captured, text: String(error instanceof Error ? error.message : error) });
        throw error;
      } finally {
        mutation.current = false;
        if (alive.current) setBusyId(undefined);
      }
    },
    save: async (values: Record<string, string>) => {
      const value = latest.current;
      const instance = value && value.id === id ? value.view.instance : undefined;
      if (!instance) throw new Error('请重新打开当前会话模式。');
      await mutate('mode-actions', {
        instanceId: instance.id,
        expectedRevision: instance.revision,
        action: { type: 'save', values },
      });
    },
    readState: () => webState(),
    runModel: (instanceId: string, run: Omit<ModRunRequest, 'instanceId'>) => {
      if (!id) throw new Error('Mod is unavailable.');
      return api<{ runId: string }>(`/api/conversations/${encodeURIComponent(id)}/mode-runs`, { instanceId, ...run });
    },
    cancelModel: async (runId: string) => {
      if (!id) throw new Error('Mod is unavailable.');
      await api(
        `/api/conversations/${encodeURIComponent(id)}/mode-runs/${encodeURIComponent(runId)}`,
        undefined,
        'DELETE',
      );
    },
    saveState: (instanceId: string, expectedRevision: number, values: Record<string, string>) =>
      webState({ instanceId, expectedRevision, values }),
  };
}
