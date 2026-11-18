import { z } from 'zod';
import type { Express } from 'express';
import type { ExternalDigest, DigestItem, DigestSettings } from '../shared/external-digest.ts';
import type { ExternalEvent, ExternalEvents } from './external-events.ts';
import type { Inbox } from './inbox.ts';
import { nextRunAt } from './scheduled-tasks.ts';

export const digestSettingsSchema = z
  .object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    destination: z.enum(['pugport', 'pugport-slack']),
  })
  .strict();
export const digestDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const line = (s: string) => s.replace(/\s+/g, ' ').trim();
export function buildDigest(events: ExternalEvent[], today: Date): ExternalDigest | undefined {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const inDay = (s: string) => Date.parse(s) >= +yesterday && Date.parse(s) < +start;
  const item = (e: ExternalEvent): DigestItem => ({
    id: e.id,
    source: e.source,
    text: line(e.text),
    group: e.repository || e.scopeLabel || e.source,
    permalink: e.permalink,
    workflowId: e.workflowId,
  });
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const pending = sorted
    .filter((e) => e.level === 'L3' && e.verdict === 'ask-owner' && !e.decision && Date.parse(e.createdAt) <= +today)
    .map((e) => ({ ...item(e), status: 'pending' as const }));
  const done = sorted
    .filter(
      (e) =>
        e.level === 'L2' &&
        e.receipt &&
        ['done', 'failed'].includes(e.receipt.state) &&
        inDay(e.receipt.history.filter((h) => h.state === 'done' || h.state === 'failed').at(-1)?.at || e.updatedAt),
    )
    .map((e) => ({ ...item(e), text: line(e.receipt!.text) }));
  const notes = sorted
    .filter((e) => e.level === 'L4' && inDay(e.createdAt))
    .map(item)
    .sort((a, b) => a.source.localeCompare(b.source) || a.group.localeCompare(b.group));
  if (!pending.length && !done.length && !notes.length) return;
  return { day: digestDay(today), pending, done, noted: notes.slice(0, 20), remaining: Math.max(0, notes.length - 20) };
}
export const digestTitle = (d: ExternalDigest) =>
  '昨天：' +
  [
    d.done.length ? `做了 ${d.done.length} 件` : '',
    d.pending.length ? `等你确认 ${d.pending.length} 件` : '',
    d.noted.length + d.remaining ? `记下 ${d.noted.length + d.remaining} 条` : '',
  ]
    .filter(Boolean)
    .join(' · ');
export function digestText(d: ExternalDigest) {
  return [
    digestTitle(d),
    ...(
      [
        ['等你确认', d.pending],
        ['做完了', d.done],
        ['记下来的', d.noted],
      ] as const
    ).flatMap(([title, items]) =>
      items.length
        ? [title, ...items.map((i) => `${i.source} · ${i.group} · ${i.text}${i.permalink ? ' ' + i.permalink : ''}`)]
        : [],
    ),
    ...(d.remaining ? [`还有 ${d.remaining} 条`] : []),
  ].join('\n');
}
type DigestRecord = {
  id: string;
  digest?: ExternalDigest;
  title?: string;
  slack: boolean;
  delivered: boolean;
  attempts: number;
  nextAttempt: number;
};
export class ExternalDigests {
  private busy?: Promise<void>;
  constructor(
    private events: ExternalEvents,
    private inbox: Inbox,
    private slack: { deliverDigest(id: string, text: string): Promise<boolean> },
    private now = () => new Date(),
  ) {}
  settings(): DigestSettings {
    return (
      this.events.store.get<DigestSettings>('external-digest-settings', 'settings') ?? {
        time: '09:00',
        destination: 'pugport-slack',
      }
    );
  }
  configure(input: unknown) {
    const settings = digestSettingsSchema.parse(input);
    this.events.store.save('external-digest-settings', 'settings', 'settings', settings);
    return settings;
  }
  async close() {
    await this.busy;
  }
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }
  refresh() {
    for (const record of this.events.store.list<DigestRecord>('external-digest', undefined, Number.MAX_SAFE_INTEGER)) {
      if (record.digest) {
        const pending = record.digest.pending.map((i) => {
          const e = this.events.get(i.id);
          return {
            ...i,
            status:
              e?.decision === 'reject'
                ? ('rejected' as const)
                : e?.decision
                  ? ('approved' as const)
                  : ('pending' as const),
          };
        });
        this.inbox.update('external-digest', record.id, {
          externalDigest: { ...record.digest, pending },
          severity: pending.some((i) => i.status === 'pending') ? 'action' : 'info',
        });
      }
    }
  }
  private async run() {
    const now = this.now(),
      settings = this.settings(),
      store = this.events.store;
    // Reuse the scheduler's wall-clock semantics, including DST gaps and folds.
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const due = nextRunAt({ type: 'daily', time: settings.time }, new Date(+midnight - 1));
    const day = digestDay(now);
    if (+now >= Date.parse(due) && !store.get<DigestRecord>('external-digest', day)) {
      store.transaction(() => {
        if (store.get('external-digest', day)) return;
        const digest = buildDigest(this.events.list(), now);
        const title = digest && digestTitle(digest);
        if (digest)
          this.inbox.raise({
            kind: 'external-digest',
            key: day,
            severity: digest.pending.length ? 'action' : 'info',
            title: title!,
            externalDigest: digest,
          });
        store.save('external-digest', day, day, {
          id: day,
          digest,
          title,
          slack: settings.destination === 'pugport-slack',
          delivered: !digest || settings.destination === 'pugport',
          attempts: 0,
          nextAttempt: 0,
        } satisfies DigestRecord);
      });
    }
    this.refresh();
    for (const record of store.list<DigestRecord>('external-digest', undefined, Number.MAX_SAFE_INTEGER)) {
      if (
        !record.digest ||
        !record.slack ||
        settings.destination === 'pugport' ||
        record.delivered ||
        record.nextAttempt > +now
      )
        continue;
      try {
        record.attempts++;
        record.nextAttempt = +now + 60000;
        store.save('external-digest', record.id, record.id, record);
        record.delivered = await this.slack.deliverDigest(record.id, digestText(record.digest));
      } catch {
        /* Persist retry below; the Inbox card is already committed. */
      }
      record.nextAttempt = +now + Math.min(60000, 1000 * 2 ** Math.min(record.attempts, 6));
      store.save('external-digest', record.id, record.id, record);
    }
  }
}
export function externalDigestRoutes(app: Express, digests: ExternalDigests) {
  app.get('/api/external-digest/settings', (_req, res) => res.json(digests.settings()));
  app.put('/api/external-digest/settings', (req, res) => res.json(digests.configure(req.body)));
}
