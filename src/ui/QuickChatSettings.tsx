import { SettingsRow } from './SettingsRow';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_QUICK_CHAT_SETTINGS, type QuickChatSettings, type QuickChatStatus } from '../shared/quick-chat';
import type { ComboRunnerDesktop } from './desktop';

export function QuickChatSettingsSection({ bridge }: { bridge: ComboRunnerDesktop }) {
  const [settings, setSettings] = useState<QuickChatStatus>({ ...DEFAULT_QUICK_CHAT_SETTINGS, registered: false });
  const [shortcut, setShortcut] = useState(DEFAULT_QUICK_CHAT_SETTINGS.shortcut);
  const [pending, setPending] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  useEffect(() => {
    void bridge.quickChatSettings!()
      .then((value) => {
        setSettings(value);
        setShortcut(value.shortcut);
      })
      .catch(() => setError('快捷聊天设置读取失败，请重新打开设置。'))
      .finally(() => {
        setPending(false);
        setLoaded(true);
      });
  }, []);
  const save = async (patch: Partial<QuickChatSettings>) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      const value = await bridge.quickChatSettings!({ ...settings, ...patch });
      setSettings(value);
      setShortcut(value.shortcut);
      if (value.enabled && !value.registered) setError('快捷聊天快捷键不可用，请换一个；原设置已保留。');
    } catch {
      setShortcut(settings.shortcut);
      setError('快捷聊天设置无法保存，请重试。');
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  const needsCheck = !!error || (settings.enabled && !settings.registered && !pending);
  if (!loaded) return null;
  return (
    <SettingsRow
      defaultExpanded={needsCheck}
      title="快捷小窗"
      description="随时唤起小窗口，发消息到日常或上次使用的对话。"
      status={needsCheck ? '需要检查' : undefined}
      tone={needsCheck ? 'danger' : undefined}
      control={
        <label className="switch">
          <input
            id="quick-chat-enabled"
            aria-label="快捷聊天"
            type="checkbox"
            checked={settings.enabled}
            disabled={pending}
            onChange={(event) => void save({ enabled: event.target.checked })}
          />
          <span />
        </label>
      }
    >
      <div className="setting-row">
        <label className="setting-label" htmlFor="quick-chat-shortcut">
          全局快捷键
        </label>
        <div className="setting-control">
          <input
            id="quick-chat-shortcut"
            value={shortcut}
            disabled={pending || !settings.enabled}
            spellCheck={false}
            onChange={(event) => setShortcut(event.target.value)}
            onBlur={() => {
              if (shortcut !== settings.shortcut) void save({ shortcut });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void save({ shortcut });
              }
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <label className="setting-label" htmlFor="quick-chat-target">
          发送到
        </label>
        <div className="setting-control">
          <select
            id="quick-chat-target"
            value={settings.target}
            disabled={pending}
            onChange={(event) => void save({ target: event.target.value as QuickChatSettings['target'] })}
          >
            <option value="everyday">日常对话</option>
            <option value="last">上次使用的对话</option>
          </select>
        </div>
      </div>
      <p className="quiet-text">随时唤起小窗口；日常对话每次新建，没有上次对话时也会新建。</p>
      {needsCheck && (
        <p className="quiet-text" role="alert">
          {error || '这个快捷键已被其他应用占用，请换一个。'}
        </p>
      )}
    </SettingsRow>
  );
}
