import { z } from 'zod';
import type { QuotaLine } from '../../shared/quota-summary.ts';
import type { DesktopApp } from './desktop-app.ts';
import { peerExecutorSchema, type PeerExecutor, type PeerRuntimes } from './peer-protocol.ts';

const capped = (max: number) => z.string().transform((value) => value.slice(0, max));
const lineSchema = z.object({
  label: capped(200),
  provider: capped(20),
  status: capped(40).optional().catch(undefined),
  plan: capped(60).optional().catch(undefined),
  reference: z.boolean().optional().catch(undefined),
  windows: z
    .array(
      z.object({
        name: z.string(),
        remaining: z.number().min(0).max(100).optional(),
        resetsAt: z.string().max(40).nullable().optional().catch(undefined),
      }),
    )
    .transform((items) => items.slice(0, 20)),
  tightest: z.number().min(0).max(100).optional().catch(undefined),
  observedAt: z.string().max(40).nullable().optional().catch(undefined),
});
/** One whitelist for both tray sources; account ids and tray details never cross the peer API. */
export function lineExecutor(value: unknown): PeerExecutor | undefined {
  const parsed = lineSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const line = parsed.data;
  const web = line.provider === 'web' && line.windows.length === 1;
  return peerExecutorSchema.parse({
    label: line.label,
    provider: line.provider,
    status: line.status ?? 'ready',
    windows: line.windows.map((window) => ({ ...window, name: web ? '额度' : window.name.slice(0, 60) })),
    plan: line.plan,
    stale: line.reference,
    tightest: line.tightest,
    observedAt: line.observedAt ?? null,
  });
}
export function trayExecutors(value: unknown): PeerExecutor[] {
  const tray = z.object({ lines: z.array(z.unknown()) }).parse(value);
  return tray.lines
    .flatMap((line) => {
      const executor = lineExecutor(line);
      return executor ? [executor] : [];
    })
    .slice(0, 100);
}
/** Keep desktop-only readings through a short tray outage, while its health endpoint still answers. */
export function nodeRuntimes(
  own: () => { lines: QuotaLine[]; running: number },
  desktop: Pick<DesktopApp, 'probe' | 'tray'>,
): () => Promise<PeerRuntimes> {
  let extras: PeerExecutor[] = [];
  let pending: Promise<PeerRuntimes> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const tray = own();
      const executors = tray.lines.flatMap((line) => {
        const value = lineExecutor(line);
        return value ? [value] : [];
      });
      if (await desktop.probe()) {
        try {
          extras = await desktop.tray();
        } catch {
          extras = extras.map((line) => ({ ...line, stale: true }));
        }
      } else extras = [];
      const labels = new Set(executors.map((line) => line.label));
      for (const line of extras) {
        if (!labels.has(line.label)) {
          executors.push(line);
          labels.add(line.label);
        }
      }
      return { executors: executors.slice(0, 100), running: tray.running };
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
