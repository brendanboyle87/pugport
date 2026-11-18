import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Api, Notice } from './Workspace';
import { translateInterfaceText, withNames } from './i18n';

export type AdmissionLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'ignore';
export type AdmissionSender = 'owner' | 'trusted' | 'other' | 'bot';
export type ChannelRule = {
  source: string;
  scope: string;
  senderId?: string;
  senderClass?: AdmissionSender | 'system';
  level: AdmissionLevel;
};
type Rules = { version: 1; rules: ChannelRule[] };
export type ChannelScope = {
  id: string;
  scopes?: string[];
  label: string;
  defaults: Record<AdmissionSender, AdmissionLevel>;
  locked?: AdmissionSender[];
};
const senders = { owner: '我', trusted: '配对的人', other: '其他人', bot: '机器人' };
const levels: Record<AdmissionLevel, string> = {
  L1: '直接做',
  L2: '做完告诉我',
  L3: '先问我',
  L4: '只记下来',
  ignore: '忽略',
};
export const slackAdmissionScopes: ChannelScope[] = [
  {
    id: 'dm',
    label: 'Slack 私信',
    defaults: { owner: 'L1', trusted: 'L2', other: 'ignore', bot: 'ignore' },
    locked: ['other', 'bot'],
  },
  {
    id: 'channel-mention',
    label: 'Slack 频道 @PugPort',
    defaults: { owner: 'L1', trusted: 'L2', other: 'L3', bot: 'ignore' },
    locked: ['bot'],
  },
];
export const githubAdmissionScopes: ChannelScope[] = [
  {
    id: 'issue',
    scopes: ['issue', 'pr', 'comment'],
    label: 'GitHub 上 @PugPort',
    defaults: { owner: 'L1', trusted: 'L2', other: 'L3', bot: 'L4' },
    locked: ['bot'],
  },
];
type Digest = { time: string; destination: 'pugport' | 'pugport-slack' };

/** Channel-specific scopes and endpoints keep the controls reusable for the next channel. */
export function ChannelAdmissionSettings({
  api,
  notify,
  source,
  endpoint,
  scopes,
  users = [],
  showDigest = true,
  senderLabels = senders,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  source: string;
  endpoint: string;
  scopes: ChannelScope[];
  users?: { id: string; name?: string; login?: string; avatarUrl?: string }[];
  showDigest?: boolean;
  senderLabels?: Record<AdmissionSender, string>;
}) {
  const [rules, setRules] = useState<Rules>();
  const [error, setError] = useState(false);
  const [digest, setDigest] = useState<Digest>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    setRules(undefined);
    setError(false);
    void api<Rules>(endpoint, undefined, 'GET').then(
      (value) => {
        if (active) setRules(value);
      },
      () => {
        if (active) setError(true);
      },
    );
    if (showDigest)
      void api<Digest>('/api/external-digest/settings', undefined, 'GET').then(
        (value) => {
          if (active && /^\d{2}:\d{2}$/.test(value.time) && ['pugport', 'pugport-slack'].includes(value.destination))
            setDigest(value);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, [api, endpoint, showDigest]);
  const save = async (action: () => Promise<void>) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await action();
    } catch {
      notify({ tone: 'error', message: '渠道设置没有保存，请重试。' });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const writeRules = (next: ChannelRule[]) =>
    save(async () => {
      setRules(await api<Rules>(endpoint, { version: 1, rules: next }, 'PUT'));
    });
  const overrides = rules?.rules.filter((rule) => rule.source === source && rule.senderId);
  return (
    <section className="channel-admission" aria-label="谁能让 PugPort 做事">
      <h4>谁能让 PugPort 做事</h4>
      {error ? (
        <p className="slack-note" role="status">
          暂时读不到渠道设置
        </p>
      ) : (
        scopes.map((scope) => (
          <div className="channel-scope" key={scope.id}>
            <div className="channel-scope-title">{scope.label}</div>
            {(Object.keys(senders) as AdmissionSender[]).map((sender) => {
              const scopeIds = scope.scopes ?? [scope.id];
              const relevant = rules?.rules.filter(
                (rule) => rule.source === source && scopeIds.includes(rule.scope) && !rule.senderId,
              );
              const override = relevant?.find((rule) => rule.senderClass === sender);
              const legacy = relevant?.find((rule) => !rule.senderClass);
              const locked = scope.locked?.includes(sender);
              const values = scopeIds.map((id) => {
                const scoped = relevant?.filter((rule) => rule.scope === id);
                return locked
                  ? scope.defaults[sender]
                  : ((scoped?.find((rule) => rule.senderClass === sender) ?? scoped?.find((rule) => !rule.senderClass))
                      ?.level ?? scope.defaults[sender]);
              });
              const value = values.every((level) => level === values[0]) ? values[0] : 'mixed';
              const reset = () => {
                const next = rules!.rules.filter(
                  (rule) =>
                    !(
                      rule.source === source &&
                      scopeIds.includes(rule.scope) &&
                      !rule.senderId &&
                      (rule.senderClass === sender || !rule.senderClass)
                    ),
                );
                // Preserve the other classes when replacing an older scope-wide preference.
                for (const id of scopeIds) {
                  const legacy = relevant?.find((rule) => rule.scope === id && !rule.senderClass);
                  if (legacy)
                    for (const other of Object.keys(senders) as AdmissionSender[]) {
                      if (
                        other !== sender &&
                        !scope.locked?.includes(other) &&
                        !relevant?.some((rule) => rule.scope === id && rule.senderClass === other)
                      )
                        next.push({ source, scope: id, senderClass: other, level: legacy.level });
                    }
                }
                return writeRules(next);
              };
              return (
                <div className="channel-admission-row" key={sender}>
                  <span>{senderLabels[sender]}</span>
                  <div className="channel-admission-actions">
                    {!locked && (override || legacy) && (
                      <button type="button" className="button quiet tiny" disabled={busy} onClick={() => void reset()}>
                        恢复默认
                      </button>
                    )}
                    <select
                      aria-label={withNames('{0} · {1}', [
                        translateInterfaceText(scope.label),
                        translateInterfaceText(senderLabels[sender]),
                      ])}
                      data-names
                      value={value}
                      disabled={!rules || busy || locked}
                      onChange={(event) =>
                        void writeRules([
                          ...rules!.rules.filter(
                            (rule) =>
                              !(
                                rule.source === source &&
                                scopeIds.includes(rule.scope) &&
                                rule.senderClass === sender &&
                                !rule.senderId
                              ),
                          ),
                          ...scopeIds.map((id) => ({
                            source,
                            scope: id,
                            senderClass: sender,
                            level: event.target.value as AdmissionLevel,
                          })),
                        ])
                      }
                    >
                      {value === 'mixed' && (
                        <option value="mixed" disabled>
                          混合
                        </option>
                      )}
                      {(Object.keys(levels) as AdmissionLevel[]).map((level) => (
                        <option key={level} value={level}>
                          {levels[level]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}
      {!!overrides?.length && (
        <div className="channel-overrides">
          <h4>按发送者的覆盖</h4>
          {overrides.map((rule) => {
            const user = users.find((user) => user.id === rule.senderId);
            // GitHub admission stores the login as senderId, not a numeric GitHub ID.
            const name = source === 'github' ? `@${user?.login ?? rule.senderId}` : (user?.name ?? rule.senderId);
            return (
              <div className="channel-admission-row" key={`${rule.scope}:${rule.senderId}`}>
                <span className="channel-sender" translate="no">
                  {user?.avatarUrl && <img src={user.avatarUrl} width={16} height={16} alt="" />}
                  {name}
                </span>
                <span>
                  {scopes.find((scope) => (scope.scopes ?? [scope.id]).includes(rule.scope))?.label ?? rule.scope} ·{' '}
                  {levels[rule.level]}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={withNames('移除 {0} 的覆盖', [name!])}
                  data-names
                  disabled={busy}
                  onClick={() => void writeRules(rules!.rules.filter((item) => item !== rule))}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {source === 'github' && (
        <>
          <div className="channel-admission-row">
            <span>没 @ 的新 issue / PR</span>
            <span className="channel-fixed-level">只记下来</span>
          </div>
          <div className="channel-admission-row">
            <span>默认分支 CI 失败</span>
            <span className="channel-fixed-level">只记下来</span>
          </div>
          <p className="slack-note channel-admission-note">
            失败提交属于我时，做完告诉我。未 @ 的请求和机器人按固定规则处理。
          </p>
        </>
      )}
      {showDigest && (
        <div className="channel-admission-row channel-digest" aria-disabled={!digest}>
          <span>每日摘要</span>
          <input
            type="time"
            aria-label="每日摘要时间"
            value={digest?.time ?? '09:00'}
            disabled={!digest || busy}
            onChange={(event) => {
              const time = event.target.value;
              if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
                void save(async () => {
                  setDigest(await api<Digest>('/api/external-digest/settings', { ...digest, time }, 'PUT'));
                });
            }}
          />
          <span>·</span>
          <select
            aria-label="摘要目的地"
            value={digest?.destination ?? 'pugport-slack'}
            disabled={!digest || busy}
            onChange={(event) => {
              const destination = event.target.value;
              void save(async () => {
                setDigest(await api<Digest>('/api/external-digest/settings', { ...digest, destination }, 'PUT'));
              });
            }}
          >
            <option value="pugport">发到 PugPort</option>
            <option value="pugport-slack">发到 PugPort 和 Slack 私信</option>
          </select>
          {!digest && <small className="slack-note">暂不可用</small>}
        </div>
      )}
    </section>
  );
}
