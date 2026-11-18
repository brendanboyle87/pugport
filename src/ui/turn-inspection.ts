let pending: { runId: string; key: string } | undefined;
export function requestTurnInspection(runId: string, key: string) {
  pending = { runId, key };
  window.dispatchEvent(new Event('pugport:turn-inspection'));
}
export function takeTurnInspection(runId: string) {
  if (pending?.runId !== runId) return;
  const key = pending.key;
  pending = undefined;
  return key;
}
