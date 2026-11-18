import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManualResetNote } from '../shared/manual-reset.ts';
import type { Store } from './store.ts';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  });
const precision = z.enum(['exact', 'date', 'estimated', 'unknown']);
const subscriptionKind = (kind: string | undefined) => kind === 'subscription-credit' || kind === 'subscription-usage';
export type ManualNoteIdentity = { provider: string; accountFingerprint?: string | null };
export const manualResetInput = z
  .object({
    id: z.string().uuid().optional(),
    kind: z.enum(['reset', 'cloud-credit', 'subscription-credit', 'subscription-usage']).default('reset'),
    creditPool: z.enum(['event', 'account']).optional(),
    expiryPrecision: precision.optional(),
    source: z.string().trim().max(300).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
    // A form may assert the identity it opened with, but cannot assign that identity.
    expectedAccountFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    subscriptionUsage: z
      .object({
        cycleResetsOn: date.nullable(),
        cycleResetsAt: z.string().datetime({ offset: true }).nullable(),
        cycleResetPrecision: precision,
        onDemandEnabled: z.boolean().nullable(),
        pools: z
          .array(
            z
              .object({
                id: z.enum(['cursor-models', 'other-models']),
                usedPercent: z.number().finite().min(0).max(100).nullable(),
              })
              .strict(),
          )
          .max(2),
      })
      .strict()
      .optional(),
    remainingUsd: z.number().finite().min(0).max(1000000).nullable().optional(),
    totalUsd: z.number().finite().min(0).max(1000000).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    label: z.string().trim().min(1).max(100),
    count: z.number().int().min(0).max(10000).nullable(),
    expiresOn: date.nullable(),
    status: z.enum(['available', 'used', 'expired', 'unknown']),
    note: z.string().trim().max(1000).default(''),
  })
  .strict()
  .refine((v) => v.remainingUsd == null || v.totalUsd == null || v.remainingUsd <= v.totalUsd, {
    message: '剩余额度不能超过总额度',
  })
  .superRefine((v, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.kind === 'subscription-credit') {
      if (!v.creditPool || !v.expiryPrecision) invalid('订阅余额需要来源分类和到期精度');
      if (v.count !== null || v.subscriptionUsage) invalid('订阅余额不能混入重置次数或用量池');
      if (v.expiryPrecision === 'exact' && (!v.expiresAt || v.expiresOn)) invalid('精确到期需要独立的完整时间');
      if ((v.expiryPrecision === 'date' || v.expiryPrecision === 'estimated') && (!v.expiresOn || v.expiresAt))
        invalid('日期到期只能填写日期');
      if (v.expiryPrecision === 'unknown' && (v.expiresAt || v.expiresOn)) invalid('未提供到期时间时不能填写截止时间');
    } else if (v.kind === 'subscription-usage') {
      if (
        !v.subscriptionUsage ||
        v.count !== null ||
        v.remainingUsd != null ||
        v.totalUsd != null ||
        v.creditPool ||
        v.expiresAt ||
        v.expiresOn
      )
        invalid('订阅用量需要独立的用量池记录');
    } else if (v.creditPool || v.expiryPrecision || v.subscriptionUsage) invalid('订阅字段只能用于订阅记录');
    const u = v.subscriptionUsage;
    if (u) {
      if (new Set(u.pools.map((p) => p.id)).size !== u.pools.length) invalid('用量池不能重复');
      if (u.cycleResetPrecision === 'exact' && (!u.cycleResetsAt || u.cycleResetsOn))
        invalid('精确重置需要独立的完整时间');
      if (
        (u.cycleResetPrecision === 'date' || u.cycleResetPrecision === 'estimated') &&
        (!u.cycleResetsOn || u.cycleResetsAt)
      )
        invalid('重置日期不能包含未确认的时刻');
      if (u.cycleResetPrecision === 'unknown' && (u.cycleResetsAt || u.cycleResetsOn)) invalid('未知重置不能填写时间');
    }
  });
/** Private local annotations only. Never feed manual counts into quota routing. */
export class ManualResetNotes {
  constructor(private store: Pick<Store, 'config' | 'setConfig'>) {}
  list(runtimeId: string, identity?: ManualNoteIdentity): ManualResetNote[] {
    const rows = this.store.config<Record<string, ManualResetNote[]>>('manualResetNotes', {})[runtimeId] ?? [];
    return rows.map((row) =>
      subscriptionKind(row.kind)
        ? {
            ...row,
            identityStatus:
              !row.accountFingerprint || !identity?.accountFingerprint
                ? 'unverified'
                : row.provider === identity.provider && row.accountFingerprint === identity.accountFingerprint
                  ? 'matched'
                  : 'different',
          }
        : row,
    );
  }
  save(runtimeId: string, input: unknown, identity?: ManualNoteIdentity): ManualResetNote[] {
    const value = manualResetInput.parse(input),
      all = this.store.config<Record<string, ManualResetNote[]>>('manualResetNotes', {}),
      rows = all[runtimeId] ?? [];
    if (value.id && !rows.some((row) => row.id === value.id)) throw Error('手动记录不存在');
    if (!value.id && rows.length >= 50) throw Error('每个入口最多保存 50 条记录');
    const old = rows.find((row) => row.id === value.id);
    if (old && subscriptionKind(old.kind) !== subscriptionKind(value.kind)) throw Error('不能改变记录的账号绑定类型');
    if (subscriptionKind(value.kind)) {
      if (identity?.provider !== 'cursor' || !identity.accountFingerprint)
        throw Error('请先刷新并确认当前 Cursor CLI 登录身份');
      if (!value.expectedAccountFingerprint) throw Error('请确认当前 Cursor 账号后重新打开记录');
      if (value.expectedAccountFingerprint && value.expectedAccountFingerprint !== identity.accountFingerprint)
        throw Error('Cursor 登录身份已更改，请重新打开记录');
      if (old && (old.provider !== identity.provider || old.accountFingerprint !== identity.accountFingerprint))
        throw Error('此记录属于其他或未确认账号，请新建当前账号记录');
    }
    const { expectedAccountFingerprint: _expected, ...fields } = value;
    const row: ManualResetNote = {
      ...fields,
      ...(subscriptionKind(value.kind)
        ? { provider: 'cursor' as const, accountFingerprint: identity!.accountFingerprint }
        : {}),
      id: value.id ?? randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    all[runtimeId] = value.id ? rows.map((old) => (old.id === value.id ? row : old)) : [...rows, row];
    this.store.setConfig('manualResetNotes', all);
    return this.list(runtimeId, identity);
  }
  remove(runtimeId: string, id: string, identity?: ManualNoteIdentity) {
    z.string().uuid().parse(id);
    const all = this.store.config<Record<string, ManualResetNote[]>>('manualResetNotes', {});
    all[runtimeId] = (all[runtimeId] ?? []).filter((row) => row.id !== id);
    this.store.setConfig('manualResetNotes', all);
    return this.list(runtimeId, identity);
  }
}
