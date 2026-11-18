import { useEffect, useId, useRef, useState } from 'react';
import { modelsFor, providerLabel, targetLabel, type RoutingCard } from '../shared/conversation-routing';
import { categoryLabel, parseRoutingRules, reorderCandidates, routingCategories } from '../shared/routing-parser';
import { routingRuleDraft } from '../shared/routing-profiles';
import type { ConversationRouting, Provider, RoutingCandidate, RoutingRuleSet } from '../shared/types';
import { effortName } from '../shared/effort';
import type { Api } from './Workspace';

export type RulesDraft = Omit<RoutingRuleSet, 'updatedAt'>;
const providersOf = (cards: RoutingCard[]): Provider[] =>
  [...new Set(cards.map((card) => card.provider))].filter((id) => id !== 'dsh');
const providerName = (provider: Provider) => (provider === 'pi' ? 'API' : (providerLabel[provider] ?? provider));
const targetValue = (candidate: RoutingCandidate) =>
  candidate.runtimeId ? `r:${candidate.runtimeId}` : candidate.provider ? `p:${candidate.provider}` : 'auto';
function targetFrom(value: string, cards: RoutingCard[]): RoutingCandidate {
  if (value.startsWith('r:')) {
    const card = cards.find((card) => card.id === value.slice(2));
    return card ? { runtimeId: card.id, provider: card.provider } : {};
  }
  return value.startsWith('p:') ? { provider: value.slice(2) as Provider } : {};
}

/** Also used for coordinator/merger roles, which remain separate from content rules. */
export function RoutingCandidateEditor({
  value,
  cards,
  label,
  onChange,
}: {
  value: RoutingCandidate;
  cards: RoutingCard[];
  label: string;
  onChange(value: RoutingCandidate): void;
}) {
  const providers = providersOf(cards);
  const models = modelsFor(value, cards);
  const efforts = models.find((model) => model.id === value.model)?.efforts ?? [];
  return (
    <div className="routing-candidate-controls">
      <select
        aria-label={`${label}交给`}
        value={targetValue(value)}
        onChange={(event) => onChange(targetFrom(event.target.value, cards))}
      >
        <option value="auto">自动选择</option>
        <optgroup label="按执行器类型">
          {providers.map((provider) => (
            <option key={provider} value={`p:${provider}`}>
              {providerName(provider)}（自动选账号）
            </option>
          ))}
        </optgroup>
        <optgroup label="指定账号">
          {cards.map((card) => (
            <option key={card.id} value={`r:${card.id}`}>
              {card.label}
            </option>
          ))}
        </optgroup>
        {value.runtimeId && !cards.some((card) => card.id === value.runtimeId) && (
          <option value={`r:${value.runtimeId}`}>{`不可用：${value.runtimeId}`}</option>
        )}
        {!value.runtimeId && value.provider && !providers.includes(value.provider) && (
          <option value={`p:${value.provider}`}>{`${providerName(value.provider)} · 不可用`}</option>
        )}
      </select>
      <select
        aria-label={`${label}的模型`}
        value={value.model ?? ''}
        onChange={(event) => onChange({ ...value, model: event.target.value || undefined, effort: undefined })}
      >
        <option value="">默认模型</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
        {value.model && !models.some((model) => model.id === value.model) && (
          <option value={value.model}>{value.model}</option>
        )}
      </select>
      <select
        aria-label={`${label}的强度`}
        value={value.effort ?? ''}
        disabled={!efforts.length}
        onChange={(event) => onChange({ ...value, effort: event.target.value || undefined })}
      >
        <option value="">默认强度</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effortName(effort)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The three stages edit a draft; only Save applies it. */
export function RoutingRulesEditor({
  value,
  cards,
  api,
  onChange,
  onParsed,
  onSave,
  onClear,
  onUndo,
  canUndo,
  saved,
  saving,
  changed,
  canSave = true,
  onError,
}: {
  value?: RulesDraft;
  cards: RoutingCard[];
  api: Api;
  onChange(value: RulesDraft): void;
  onParsed?(value: Omit<ConversationRouting, 'updatedAt'>): void;
  onSave(value: RulesDraft): void;
  onClear?(): void;
  onUndo?(): void;
  canUndo?: boolean;
  saved?: boolean;
  saving?: boolean;
  changed?: boolean;
  canSave?: boolean;
  onError(message: string): void;
}) {
  const providers = providersOf(cards);
  const [text, setText] = useState(value?.text ?? '');
  const [parsing, setParsing] = useState(false);
  const [fallback, setFallback] = useState(false);
  const request = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => setText(value?.text ?? ''), [value?.text]);
  const [excludedText, setExcludedText] = useState((value?.excludeModels ?? []).join(', '));
  const editedExclusions = useRef(value?.excludeModels);
  useEffect(() => {
    if (editedExclusions.current !== value?.excludeModels) setExcludedText((value?.excludeModels ?? []).join(', '));
    editedExclusions.current = value?.excludeModels;
  }, [value?.excludeModels]);
  const stageId = useId();
  const [categoryMode, setCategoryMode] = useState<boolean>();
  const verifierBackup = useRef<RoutingCandidate[]>([]);
  const stale = (value?.text ?? '') !== text.trim();
  const empty: RulesDraft = { version: 2, text: text.trim(), rules: [], unparsed: [] };
  const current = value ?? empty;
  const byCategory = categoryMode ?? current.rules.some((rule) => rule.enabled && rule.candidates.length > 0);
  const visibleRules = [...routingCategories, ...(current.categories ?? [])]
    .filter((category) => category.id !== 'adult' || current.rules.some((rule) => rule.category === 'adult'))
    .map(
      (category) =>
        current.rules.find((rule) => rule.category === category.id) ?? {
          id: 'manual:' + category.id,
          category: category.id,
          candidates: [],
          strict: false,
          enabled: true,
          source: 'manual' as const,
        },
    );
  async function compile() {
    const id = ++request.current;
    const source = text.trim();
    setParsing(true);
    let result: { draft: Omit<ConversationRouting, 'updatedAt'>; fallback: boolean };
    try {
      result = await api('/api/routing-profiles/compile', { text: source, categories: current.categories });
    } catch {
      result = { draft: parseRoutingRules(source, cards, current.categories), fallback: true };
    }
    if (id !== request.current) return;
    setParsing(false);
    if (source !== textRef.current.trim()) return;
    setFallback(result.fallback);
    setCategoryMode(undefined);
    const parsed = {
      ...result.draft,
      ...(current.selection === undefined ? {} : { selection: current.selection }),
      ...(current.excludeModels === undefined ? {} : { excludeModels: current.excludeModels }),
    };
    if (onParsed) onParsed(parsed);
    else onChange(routingRuleDraft(parsed));
  }
  useEffect(() => {
    if (!stale || !text.trim() || parsing || saving) return;
    const timer = setTimeout(() => void compile(), 700);
    return () => clearTimeout(timer);
  }, [text, stale, parsing, saving]);
  const patch = (id: string, change: Partial<RulesDraft['rules'][number]>) =>
    onChange({
      ...current,
      rules: current.rules.some((rule) => rule.id === id)
        ? current.rules.map((rule) => (rule.id === id ? { ...rule, ...change, source: 'manual' } : rule))
        : [...current.rules, { ...visibleRules.find((rule) => rule.id === id)!, ...change, source: 'manual' }],
    });
  return (
    <>
      <div className="routing-description">
        <label htmlFor={stageId + '-text'}>用一句话描述也行</label>
        <textarea
          id={stageId + '-text'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={4000}
          rows={2}
          aria-label="路由规则原话"
          placeholder="用自然语言描述路由方式，例如：简单问题优先快速模型，复杂任务优先编程模型；额度不足时切换可用账号。"
        />
        <div className="routing-description-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!text.trim() || saving || parsing}
            onClick={() => void compile()}
          >
            {parsing ? '解析中…' : '重新解析'}
          </button>
        </div>
      </div>
      {value && stale && <p className="routing-stale">原话已修改，保存前会先更新草稿。</p>}
      {fallback && <p className="panel-note">模型暂时不可用，用的是本地解析</p>}
      <ol className="routing-flow" aria-label="路由流程">
        <li className="routing-stage">
          <fieldset className="settings-fields" disabled={parsing}>
            <legend data-i18n="路由阶段：开始">开始</legend>
            <RoutingCandidateEditor
              label="开始"
              value={current.roles?.coordinator ?? {}}
              cards={cards}
              onChange={(coordinator) =>
                onChange({
                  ...current,
                  roles: {
                    ...current.roles,
                    coordinator: Object.values(coordinator).some(Boolean) ? coordinator : undefined,
                  },
                })
              }
            />
            <p className="panel-note">负责规划并分配子任务。</p>
          </fieldset>
        </li>
        <li className="routing-stage">
          <fieldset className="settings-fields" disabled={parsing}>
            <legend data-i18n="路由阶段：执行">执行</legend>
            <div className="routing-stage-switch" role="group" aria-label="子任务路由方式">
              <label>
                <input
                  type="radio"
                  name={stageId + '-execution'}
                  aria-label="自动执行子任务"
                  checked={!byCategory}
                  onChange={() => setCategoryMode(false)}
                />
                <span data-i18n="路由阶段：自动">自动</span>
              </label>
              <label>
                <input
                  type="radio"
                  name={stageId + '-execution'}
                  aria-label="按分类指定子任务"
                  checked={byCategory}
                  onChange={() => setCategoryMode(true)}
                />
                按分类指定
              </label>
            </div>
            <p className="panel-note">未指定的分类自动选择。</p>
            {byCategory && (
              <>
                <div className="routing-rules">
                  {visibleRules.map((rule) => {
                    const label = categoryLabel(rule.category, current.categories);
                    return (
                      <div className="routing-rule" key={rule.id}>
                        <span className="routing-topic">{label}</span>
                        <select
                          aria-label={`${label}规则方式`}
                          value={!rule.enabled ? 'auto' : rule.strict ? 'strict' : 'prefer'}
                          onChange={(event) =>
                            patch(rule.id, {
                              enabled: event.target.value !== 'auto',
                              strict: event.target.value === 'strict',
                            })
                          }
                        >
                          <option value="prefer">优先</option>
                          <option value="strict">强制</option>
                          {!rule.enabled && <option value="auto">自动</option>}
                        </select>
                        <div className="routing-candidates" role="list" aria-label={`${label}候选顺序`}>
                          {rule.candidates.map((candidate, index) => (
                            <div
                              className="routing-candidate-chip"
                              role="listitem"
                              key={index}
                              draggable
                              onDragStart={(event) => event.dataTransfer.setData('text/plain', `${rule.id}:${index}`)}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={(event) => {
                                event.preventDefault();
                                const data = event.dataTransfer.getData('text/plain');
                                const prefix = `${rule.id}:`;
                                if (!data.startsWith(prefix)) return;
                                const from = Number(data.slice(prefix.length));
                                if (!Number.isInteger(from)) return;
                                patch(rule.id, { candidates: reorderCandidates(rule, from, index).candidates });
                              }}
                            >
                              <span>
                                {index + 1}. {targetLabel(candidate, cards)}
                                {candidate.model ? ` · ${candidate.model}` : ''}
                                {candidate.effort ? ` · ${effortName(candidate.effort)}` : ''}
                              </span>
                              <RoutingCandidateEditor
                                value={candidate}
                                cards={cards}
                                label={`${label}候选 ${index + 1}`}
                                onChange={(next) =>
                                  patch(rule.id, {
                                    candidates: rule.candidates.map((item, at) => (at === index ? next : item)),
                                  })
                                }
                              />
                              <div className="routing-chip-actions">
                                <button
                                  type="button"
                                  aria-label={`上移${label}候选 ${index + 1}`}
                                  disabled={index === 0}
                                  onClick={() =>
                                    patch(rule.id, { candidates: reorderCandidates(rule, index, index - 1).candidates })
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  aria-label={`下移${label}候选 ${index + 1}`}
                                  disabled={index === rule.candidates.length - 1}
                                  onClick={() =>
                                    patch(rule.id, { candidates: reorderCandidates(rule, index, index + 1).candidates })
                                  }
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  aria-label={`删除${label}候选 ${index + 1}`}
                                  onClick={() =>
                                    patch(rule.id, { candidates: rule.candidates.filter((_, at) => at !== index) })
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            </div>
                          ))}
                          {!rule.candidates.length && <span className="panel-note">自动选择</span>}
                        </div>
                        <select
                          aria-label={`${label}添加候选`}
                          value=""
                          disabled={rule.candidates.length >= 8}
                          onChange={(event) =>
                            patch(rule.id, { candidates: [...rule.candidates, targetFrom(event.target.value, cards)] })
                          }
                        >
                          <option value="" disabled>
                            +候选
                          </option>
                          <option value="auto">自动选择</option>
                          {providers.map((provider) => (
                            <option key={provider} value={`p:${provider}`}>
                              {providerName(provider)}
                            </option>
                          ))}
                          {cards.map((card) => (
                            <option key={card.id} value={`r:${card.id}`}>
                              {card.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </fieldset>
        </li>
        <li className="routing-stage">
          <fieldset className="settings-fields" disabled={parsing}>
            <legend>核验</legend>
            <label className="routing-stage-check">
              <input
                type="checkbox"
                aria-label="完成后核验"
                checked={!!current.roles?.verifier?.length}
                onChange={(event) => {
                  if (!event.target.checked) verifierBackup.current = current.roles?.verifier ?? [];
                  onChange({
                    ...current,
                    roles: {
                      ...current.roles,
                      verifier: event.target.checked
                        ? verifierBackup.current.length
                          ? verifierBackup.current
                          : [{}]
                        : undefined,
                    },
                  });
                }}
              />
              完成后核验
            </label>
            {!!current.roles?.verifier?.length && (
              <>
                <p className="panel-note">首选不可用时使用备用模型。</p>
                {current.roles.verifier.map((candidate, index) => (
                  <div className="routing-verifier" key={index}>
                    <span className="routing-topic">{index === 0 ? '核验模型' : '备用'}</span>
                    <RoutingCandidateEditor
                      label={`核验候选 ${index + 1}`}
                      value={candidate}
                      cards={cards}
                      onChange={(next) =>
                        onChange({
                          ...current,
                          roles: {
                            ...current.roles,
                            verifier: current.roles?.verifier?.map((item, at) => (at === index ? next : item)),
                          },
                        })
                      }
                    />
                    {index > 0 && (
                      <button
                        type="button"
                        className="button quiet"
                        aria-label={`删除核验候选 ${index + 1}`}
                        onClick={() =>
                          onChange({
                            ...current,
                            roles: {
                              ...current.roles,
                              verifier: current.roles?.verifier?.filter((_, at) => at !== index),
                            },
                          })
                        }
                      >
                        移除备用
                      </button>
                    )}
                  </div>
                ))}
                {current.roles.verifier.length < 2 && (
                  <button
                    type="button"
                    className="button quiet"
                    onClick={() =>
                      onChange({ ...current, roles: { ...current.roles, verifier: [...current.roles!.verifier!, {}] } })
                    }
                  >
                    添加备用
                  </button>
                )}
              </>
            )}
          </fieldset>
        </li>
      </ol>
      {!!current.unparsed.length && (
        <p className="panel-note routing-unmapped">
          <span>这句没对应上，请在上面直接选：</span>
          <span translate="no">{current.unparsed.join('；')}</span>
        </p>
      )}
      <details className="target-advanced">
        <summary>候选排序、模型限制与自定义分类</summary>
        <fieldset className="settings-fields" disabled={parsing}>
          <label className="field">
            <span>规则候选的选择方式</span>
            <select
              aria-label="规则候选的选择方式"
              value={current.selection ?? 'ordered'}
              onChange={(event) => onChange({ ...current, selection: event.target.value as 'ordered' | 'quota' })}
            >
              <option value="ordered">按候选顺序</option>
              <option value="quota">比较可用候选的剩余额度</option>
            </select>
          </label>
          <label className="field">
            <span>自动选择时排除这些模型</span>
            <input
              aria-label="自动选择时排除这些模型"
              value={excludedText}
              onChange={(event) => {
                const raw = event.target.value;
                const models = raw
                  .split(/[,，\n]+/)
                  .map((item) => item.trim())
                  .filter(Boolean);
                editedExclusions.current = models;
                setExcludedText(raw);
                onChange({ ...current, excludeModels: models });
              }}
              placeholder="model-id, *-light-*"
              maxLength={4000}
            />
            <small>逗号分隔，支持 * 通配符。适用于自动选择和故障切换；手动指定的模型优先。</small>
          </label>
          {(current.categories ?? []).map((category) => (
            <div className="fields-grid two" key={category.id}>
              <label className="field">
                <span>分类名称</span>
                <input
                  aria-label={`分类名称 ${category.id}`}
                  value={category.label}
                  maxLength={80}
                  onChange={(event) =>
                    onChange({
                      ...current,
                      categories: current.categories?.map((item) =>
                        item.id === category.id ? { ...item, label: event.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>分类关键词</span>
                <input
                  aria-label={`分类关键词 ${category.id}`}
                  defaultValue={(category.keywords ?? []).join(', ')}
                  maxLength={2400}
                  onBlur={(event) =>
                    onChange({
                      ...current,
                      categories: current.categories?.map((item) =>
                        item.id === category.id
                          ? {
                              ...item,
                              keywords: event.target.value
                                .split(/[,，]+/)
                                .map((word) => word.trim())
                                .filter(Boolean),
                            }
                          : item,
                      ),
                    })
                  }
                />
                <small>逗号分隔；英文词按完整词匹配，避免误中其他单词。</small>
              </label>
              <button
                type="button"
                className="button quiet"
                aria-label={`删除自定义分类 ${category.label}`}
                onClick={() =>
                  onChange({
                    ...current,
                    categories: current.categories?.filter((item) => item.id !== category.id),
                    rules: current.rules.filter((rule) => rule.category !== category.id),
                  })
                }
              >
                删除自定义分类
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button secondary"
            disabled={(current.categories?.length ?? 0) >= 30}
            onClick={() =>
              onChange({
                ...current,
                categories: [
                  ...(current.categories ?? []),
                  { id: `custom:${crypto.randomUUID()}`, label: `自定义分类 ${(current.categories?.length ?? 0) + 1}` },
                ],
              })
            }
          >
            添加自定义分类
          </button>
        </fieldset>
      </details>
      <div className="dialog-actions">
        {canUndo && onUndo && (
          <button type="button" className="button secondary" disabled={saving} onClick={onUndo}>
            撤销上一次
          </button>
        )}
        {saved && onClear && (
          <button type="button" className="button secondary" disabled={saving} onClick={onClear}>
            清除规则
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={saving || parsing || !canSave || (!stale && changed === false && categoryMode === undefined)}
          onClick={() =>
            stale ? void compile() : onSave({ ...current, text: text.trim(), rules: byCategory ? current.rules : [] })
          }
        >
          {saved ? '保存修改' : '保存并启用'}
        </button>
      </div>
    </>
  );
}
