import type { RunRecord } from './types.ts';

/** Legacy classifier reasons are omitted from the app view; the stored record is unchanged. */
export function withoutJevReasons(run: RunRecord): RunRecord {
  const keep = (reasons: unknown) =>
    Array.isArray(reasons) ? reasons.filter((reason) => !/\bJev\b/.test(reason)) : reasons;
  // Older or partial records can lack either field; building the app state must not throw over one.
  return {
    ...run,
    ...(run.route && { route: { ...run.route, reasons: keep(run.route.reasons) as string[] } }),
    // The routing event carries a copy of the route, shown in the trajectory and raw event views.
    events: run.events?.map((event) => {
      const detail =
        event.data?.kind === 'routing' ? (event.data.detail as Record<string, unknown> | undefined) : undefined;
      return detail?.reasons
        ? { ...event, data: { ...event.data, detail: { ...detail, reasons: keep(detail.reasons) } } }
        : event;
    }),
  };
}
