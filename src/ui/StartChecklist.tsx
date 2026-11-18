import { createContext, useContext, useId, useLayoutEffect } from 'react';
import { isNativeCli } from '../shared/provider-registry';
import { cliReadiness, hasUsableAccount } from '../shared/runtime-readiness';
import type { AppState } from '../shared/types';
import { CliConnectionAction } from './Executors';
import { shownName } from './i18n';
import type { Api, Notice } from './Workspace';

export const StartChecklistAccountsContext = createContext<(() => void) | undefined>(undefined);
export const StartChecklistVisibilityContext = createContext<((id: string, shown: boolean) => void) | undefined>(
  undefined,
);

export function StartChecklist({
  state,
  api,
  reload,
  notify,
  onOpenAccounts,
  visible = true,
}: {
  state: AppState;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
  onOpenAccounts?: () => void;
  visible?: boolean;
}) {
  const accountsContext = useContext(StartChecklistAccountsContext);
  const visibility = useContext(StartChecklistVisibilityContext);
  const id = useId();
  const usable = hasUsableAccount(state);
  const shown = visible && !usable;
  useLayoutEffect(() => {
    visibility?.(id, shown);
    return () => visibility?.(id, false);
  }, [id, shown, visibility]);
  const openAccounts = onOpenAccounts ?? accountsContext;
  if (usable) return null;
  const detected = state.targets.flatMap((target) => {
    const snapshot = state.runtimes.find((runtime) => runtime.id === target.id);
    return isNativeCli(target.provider) && !target.gateway && target.environment === 'native' && snapshot?.installed
      ? [{ target, snapshot }]
      : [];
  });
  return (
    <section className="start-checklist" aria-label="开始前">
      <h2>开始前</h2>
      {detected.length ? (
        <ul>
          {detected.map(({ target, snapshot }) => {
            const { usable, label } = cliReadiness(target, snapshot);
            return (
              <li key={target.id} className="start-checklist-row">
                <span className="start-checklist-name" translate="no">
                  {shownName(target.label)}
                </span>
                <span className="start-checklist-status">{label}</span>
                {!usable && <CliConnectionAction {...{ state, api, reload, notify, target, snapshot }} />}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="start-checklist-row">
          <span>尚未发现 CLI。</span>
          <button type="button" className="button quiet tiny" onClick={openAccounts}>
            安装一个 CLI
          </button>
        </div>
      )}
    </section>
  );
}
