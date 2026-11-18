import { useEffect, useState } from 'react';
import { startUiUpdates } from './ui-update';

declare const __PUGPORT_UI_BUILD_ID__: string;
declare const __PUGPORT_UI_COMPATIBILITY__: string;

export function UiUpdateNotice() {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const ready = window.requestAnimationFrame(() => window.dispatchEvent(new Event('pugport:ui-ready')));
    const stop = startUiUpdates(
      typeof __PUGPORT_UI_BUILD_ID__ === 'string' ? __PUGPORT_UI_BUILD_ID__ : 'development',
      typeof __PUGPORT_UI_COMPATIBILITY__ === 'string' ? __PUGPORT_UI_COMPATIBILITY__ : 'development',
      setPending,
    );
    return () => {
      window.cancelAnimationFrame(ready);
      stop();
    };
  }, []);
  return pending ? (
    <div className="ui-update-notice" role="status">
      界面更新已就绪。当前编辑结束后自动加载，后台任务继续运行。
    </div>
  ) : null;
}
