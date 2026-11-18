import { quotaPlan } from '../shared/quota-summary';
import { useState } from 'react';
import type { AppState } from '../shared/types';
import { automaticApiTarget, emptyExecutorReason, executorCards } from '../shared/automatic-executors';
import { ProviderMark } from './App';
import { isFreePreset } from '../shared/api-providers';
import { shownName, withNames } from './i18n';

export function ExecutorChecklist({
  state,
  value,
  onChange,
  disabled = false,
}: {
  state: AppState;
  value?: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState('');
  const cards = executorCards(state.targets);
  const selected =
    value ?? cards.filter((card) => card.gateway !== 'api' || isFreePreset(card.apiProvider)).map((card) => card.id);
  function change(ids: string[]) {
    if (!cards.some((card) => ids.includes(card.id) && (card.gateway !== 'api' || isFreePreset(card.apiProvider)))) {
      setError(emptyExecutorReason);
      return;
    }
    setError('');
    onChange(ids);
  }
  return (
    <div className="executor-checklist">
      <div className="executor-checklist-title">
        <strong>允许自动选择的执行器</strong>
        <button
          type="button"
          className="button tiny quiet"
          disabled={disabled}
          onClick={() =>
            change(
              cards.filter((card) => card.gateway !== 'api' || isFreePreset(card.apiProvider)).map((card) => card.id),
            )
          }
        >
          全选
        </button>
        <button type="button" className="button tiny quiet" disabled={disabled} onClick={() => change([])}>
          全不选
        </button>
      </div>
      <p className="panel-note">未勾选的执行器仍可显式点名使用；自动规划、执行、接力和审查只用勾选项。</p>
      <table aria-label="自动执行器列表">
        <thead>
          <tr>
            <th scope="col">执行器</th>
            <th scope="col">套餐</th>
            <th scope="col">自动选择</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const runtime = state.runtimes.find((runtime) => runtime.id === card.id);
            const plan = quotaPlan(runtime)?.label;
            return (
              <tr key={card.id}>
                <td>
                  <span className="executor-checklist-card">
                    <ProviderMark provider={card.provider} small />
                    <span translate="no">{shownName(card.label)}</span>
                  </span>
                </td>
                <td>
                  <span className="tag">{plan ?? (card.gateway === 'api' ? 'API' : '未知套餐')}</span>
                </td>
                <td>
                  {card.gateway === 'api' && !isFreePreset(card.apiProvider) && (
                    <span>
                      {runtime && automaticApiTarget(runtime, Date.now())
                        ? '到期额度按计划自动使用'
                        : '按次计费，钉选后可用'}{' '}
                    </span>
                  )}
                  <input
                    type="checkbox"
                    aria-label={withNames('自动选择 {0}', [shownName(card.label)])}
                    data-names
                    disabled={disabled || (card.gateway === 'api' && !isFreePreset(card.apiProvider))}
                    checked={selected.includes(card.id) && (card.gateway !== 'api' || isFreePreset(card.apiProvider))}
                    onChange={(event) =>
                      change(event.target.checked ? [...selected, card.id] : selected.filter((id) => id !== card.id))
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
