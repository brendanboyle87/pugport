import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { WorkspaceStore } from '../workspace-store.ts';
import { outboxItemSchema } from '../node/peer-protocol.ts';

export type OutboxItem = z.infer<typeof outboxItemSchema>;
export type OutboxKind = OutboxItem['kind'];
export interface Outbox {
  /** The newest 100 open cards, oldest first: what the desktop shows. */
  open(repository?: string): OutboxItem[];
  /** Every open card, for the host's own lookups. */
  all(repository?: string): OutboxItem[];
  raise(item: Omit<OutboxItem, 'id' | 'createdAt'>): OutboxItem;
  resolve(id: string, resolution: OutboxItem['resolution']): OutboxItem | undefined;
  supersede(number: number, newSha: string, repository?: string): void;
}
const kind = 'maintainer-card';
export const cardRepository = (item: Pick<OutboxItem, 'url'>) =>
  new URL(item.url).pathname.split('/').slice(1, 3).join('/');
const cardKey = (item: OutboxItem) => `${cardRepository(item)}#${item.number}:${item.id}`;
export class StoreOutbox implements Outbox {
  constructor(
    private readonly store: Pick<WorkspaceStore, 'get' | 'list' | 'save'>,
    private readonly now = Date.now,
  ) {}
  private allOpen(repository?: string) {
    const items = this.store
      .list<OutboxItem>(kind, 'maintainer:open', 1000)
      .filter((item) => !item.resolution && (!repository || cardRepository(item) === repository));
    for (const item of items)
      if (item.expiresAt && Date.parse(item.expiresAt) <= this.now())
        this.resolve(item.id, {
          outcome: 'superseded',
          at: new Date(this.now()).toISOString(),
          detail: 'Card expired',
        });
    return items
      .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > this.now())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  open(repository?: string) {
    return this.allOpen(repository).slice(-100);
  }
  all(repository?: string) {
    return this.allOpen(repository);
  }
  raise(input: Omit<OutboxItem, 'id' | 'createdAt'>): OutboxItem {
    if (input.kind === 'suite' && input.mode === 'shadow') throw new Error('Shadow mode cannot request the full suite');
    if (input.kind === 'suite' && input.external) throw new Error('External PRs cannot request the full suite');
    const existing = this.allOpen(cardRepository(input)).find(
      (item) =>
        item.kind === input.kind &&
        item.number === input.number &&
        item.judgedSha === input.judgedSha &&
        item.baseRef === input.baseRef,
    );
    if (existing) {
      const reasons = [...new Set([...existing.reasons, ...input.reasons])];
      if (reasons.length !== existing.reasons.length) {
        existing.reasons = reasons;
        this.store.save(kind, cardKey(existing), 'maintainer:open', existing);
      }
      return existing;
    }
    const createdAt = new Date(this.now()).toISOString();
    const item = outboxItemSchema.parse({
      ...input,
      id: `card-${createdAt.slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`,
      createdAt,
      expiresAt: input.expiresAt ?? new Date(this.now() + 14 * 86400_000).toISOString(),
    });
    this.store.save(kind, cardKey(item), 'maintainer:open', item);
    return item;
  }
  resolve(id: string, resolution: OutboxItem['resolution']) {
    const item = this.store.list<OutboxItem>(kind, 'maintainer:open', 1000).find((item) => item.id === id);
    if (!item || item.resolution || !resolution) return undefined;
    const resolved = outboxItemSchema.parse({ ...item, resolution });
    this.store.save(kind, cardKey(item), 'maintainer:closed', resolved);
    return resolved;
  }
  supersede(number: number, newSha: string, repository?: string) {
    for (const item of this.allOpen(repository))
      if (item.number === number && item.judgedSha !== newSha) {
        const resolved = outboxItemSchema.parse({
          ...item,
          supersededBy: newSha,
          resolution: { outcome: 'superseded', at: new Date(this.now()).toISOString() },
        });
        this.store.save(kind, cardKey(item), 'maintainer:closed', resolved);
      }
  }
}
