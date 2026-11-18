export type QuickChatSettings = {
  enabled: boolean;
  shortcut: string;
  target: 'everyday' | 'last';
};

export type QuickChatStatus = QuickChatSettings & { registered: boolean };
export type QuickChatConversation = {
  id: string;
  title: string;
  project: string;
  composerSendKey?: 'enter' | 'ctrl-enter';
};

export const DEFAULT_QUICK_CHAT_SETTINGS: QuickChatSettings = {
  enabled: true,
  shortcut: 'Ctrl+Alt+Space',
  target: 'everyday',
};

export function isQuickChatSettings(value: unknown): value is QuickChatSettings {
  if (!value || typeof value !== 'object') return false;
  const item = value as QuickChatSettings;
  return (
    typeof item.enabled === 'boolean' &&
    typeof item.shortcut === 'string' &&
    item.shortcut.trim().length > 0 &&
    item.shortcut.length <= 100 &&
    (item.target === 'everyday' || item.target === 'last')
  );
}
