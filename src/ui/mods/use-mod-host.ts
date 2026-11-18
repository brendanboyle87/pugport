import { useEffect, useMemo, useRef } from 'react';
import type { Conversation, ConversationMessage, Project } from '../../shared/types';
import type { ConversationModeView } from '../../shared/conversation-modes';
import { currentLocale } from '../i18n';
import {
  ModBridgeError,
  type ModHostContext,
  type ModHostInfo,
  type ModModelRun,
  type ModState,
} from './mod-host-bridge';
import { startModVoice, type ModVoiceDevices } from './mod-voice';
import { createModDataHost } from './mod-data-host';

export function modTheme(): Pick<ModHostInfo, 'theme' | 'tokens'> {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return {
    theme: root.dataset.theme === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(
      [
        '--text',
        '--muted',
        '--accent',
        '--accent-text',
        '--surface-1',
        '--sidebar',
        '--border',
        '--focus',
        '--bg',
        '--surface-2',
        '--hover',
        '--border-strong',
        '--faint',
        '--on-accent',
        '--danger',
        '--radius-md',
        '--radius-lg',
        '--font',
      ].map((key) => [key, style.getPropertyValue(key).trim()]),
    ),
  };
}

type Input = {
  enabled: boolean;
  conversation?: Conversation;
  project?: Project;
  view?: ConversationModeView;
  hostVersion: string;
  messages: ConversationMessage[];
  read(): Promise<ConversationModeView>;
  save(instanceId: string, revision: number, values: Record<string, string>): Promise<ConversationModeView>;
  insert(text: string, mode: 'append' | 'replace'): void;
  chat?(open: boolean): void;
  toggleChat?(): void;
  notify(title: string, message: string): void;
  runModel?(instanceId: string, input: ModModelRun): Promise<{ runId: string }>;
  cancelModel?(runId: string): Promise<void>;
  voiceDevices?: ModVoiceDevices;
  /** The window's API: Mod storage, bank connections and file import go through the server with the binding. */
  api?: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
};
// The API helper keeps the server's fixed public message, not its code.
const publicCodes: Record<string, ModBridgeError['code']> = {
  'State revision changed.': 'E_CONFLICT',
  'Invalid request.': 'E_INVALID',
  'Permission is not declared.': 'E_PERMISSION',
  'Request limit exceeded.': 'E_LIMIT',
};
const bridgeError = (error: unknown) =>
  error instanceof ModBridgeError
    ? error
    : new ModBridgeError(publicCodes[error instanceof Error ? error.message : ''] ?? 'E_UNAVAILABLE');

/** Only this adapter sees host models. The bridge receives an explicit, bounded projection. */
export function useModHost(input: Input): ModHostContext | undefined {
  const latest = useRef(input);
  latest.current = input;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const binding = input.conversation?.modeBinding;
  const key = JSON.stringify([
    input.conversation?.id,
    binding?.modeId,
    binding?.version,
    binding?.instanceId,
    input.enabled,
  ]);
  return useMemo(() => {
    const { conversation, view } = input;
    if (!input.enabled || !conversation || !binding || !view?.manifest || view.instance?.id !== binding.instanceId)
      return;
    const captured = { ...binding };
    const isCurrent = () => {
      const now = latest.current;
      const active = now.conversation?.modeBinding;
      return (
        alive.current &&
        now.enabled &&
        now.conversation?.id === conversation.id &&
        active?.instanceId === captured.instanceId &&
        active.modeId === captured.modeId &&
        active.version === captured.version &&
        now.view?.installed === true &&
        now.view.instance?.id === captured.instanceId
      );
    };
    const stateResult = async (operation: () => Promise<ConversationModeView>): Promise<ModState> => {
      if (!isCurrent()) throw new ModBridgeError('E_UNAVAILABLE');
      try {
        const result = await operation();
        if (
          !isCurrent() ||
          result.binding?.instanceId !== captured.instanceId ||
          result.instance?.id !== captured.instanceId
        )
          throw new ModBridgeError('E_UNAVAILABLE');
        return { revision: result.instance.revision, values: result.instance.state };
      } catch (error) {
        throw bridgeError(error);
      }
    };
    return {
      conversationId: conversation.id,
      modId: captured.modeId,
      version: captured.version,
      instanceId: captured.instanceId,
      manifest: view.manifest,
      isCurrent,
      info: () => ({
        apiVersion: 2,
        hostVersion: latest.current.hostVersion,
        locale: currentLocale(),
        ...modTheme(),
        slot: 'rightPanel',
        layout: 'panel',
        conversation: { id: conversation.id, title: latest.current.conversation!.title },
        ...(latest.current.project
          ? { project: { id: latest.current.project.id, name: latest.current.project.name } }
          : {}),
      }),
      getState: () => stateResult(() => latest.current.read()),
      setState: (values, revision) => stateResult(() => latest.current.save(captured.instanceId, revision, values)),
      messages: () =>
        latest.current.messages
          .filter((item) => item.conversationId === conversation.id)
          .map((item) => ({
            id: item.id,
            role: item.role,
            content: item.content,
            createdAt: item.createdAt,
            ...(item.attachments ? { attachments: item.attachments.map(({ name, kind }) => ({ name, kind })) } : {}),
          })),
      insert: (text, mode) => {
        if (!isCurrent()) throw new ModBridgeError('E_UNAVAILABLE');
        latest.current.insert(text, mode);
      },
      chat: (open) => {
        if (!isCurrent() || !latest.current.chat) throw new ModBridgeError('E_UNAVAILABLE');
        latest.current.chat(open);
      },
      toggleChat: () => {
        if (isCurrent()) latest.current.toggleChat?.();
      },
      notify: (title, message) => latest.current.notify(title, message),
      granted: () => (isCurrent() ? (latest.current.view?.granted ?? []) : []),
      runModel: async (run) => {
        if (!isCurrent() || !latest.current.runModel) throw new ModBridgeError('E_UNAVAILABLE');
        try {
          return await latest.current.runModel(captured.instanceId, run);
        } catch (error) {
          throw bridgeError(error);
        }
      },
      cancelModel: async (runId) => {
        if (!isCurrent() || !latest.current.cancelModel) throw new ModBridgeError('E_UNAVAILABLE');
        try {
          await latest.current.cancelModel(runId);
        } catch (error) {
          throw bridgeError(error);
        }
      },
      ...(input.api
        ? {
            data: createModDataHost({
              api: input.api,
              conversationId: conversation.id,
              instanceId: captured.instanceId,
              modId: view.manifest.id,
              title: view.manifest.title,
            }),
          }
        : {}),
      ...(input.voiceDevices
        ? {
            voice: {
              status: async () => {
                const devices = input.voiceDevices!;
                const live = (await devices.live?.status().catch(() => undefined)) ?? {
                  provider: 'local' as const,
                  reason: 'no-card' as const,
                };
                const local = await devices.available().catch(() => false);
                return {
                  provider: live.provider,
                  available: live.provider === 'gpt-live' || local,
                  gptLive: {
                    available: live.provider === 'gpt-live',
                    ...(live.provider !== 'gpt-live' && live.reason ? { reason: live.reason } : {}),
                  },
                };
              },
              start: (options, emit) => startModVoice(input.voiceDevices!, options, emit),
            },
          }
        : {}),
    } satisfies ModHostContext;
  }, [key, input.view?.instance?.id, input.view?.installed, !!input.view?.manifest]);
}
