import { useState } from 'react';
import { X } from 'lucide-react';
import type { SettingsCategory } from './settings-categories';

const noticeKey = 'pugport.laya-notice-dismissed';

export function LayaFirstUseNotice({
  onOpenSettings,
}: {
  onOpenSettings: (category: SettingsCategory, focusId?: string) => void;
}) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(noticeKey) === '1';
    } catch {
      return false;
    }
  });
  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(noticeKey, '1');
    } catch {
      /* Keep the dismissal for this mounted composer if storage is unavailable. */
    }
  }
  if (dismissed) return null;
  return (
    <div className="composer-once-writer" role="note" style={{ flexWrap: 'wrap', paddingInlineEnd: 14 }}>
      <span style={{ flex: '1 1 260px' }}>
        开启“帮助改进路由”时，PugPort 会收集你的提问和路由结果，并清除密钥，用于改进自动选模型。可在设置中关闭。
      </span>
      <button
        type="button"
        className="button secondary tiny"
        onClick={() => {
          dismiss();
          onOpenSettings('routing', 'settings-laya-sharing');
        }}
      >
        设置
      </button>
      <button type="button" className="icon-button" aria-label="关闭路由数据提示" onClick={dismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
