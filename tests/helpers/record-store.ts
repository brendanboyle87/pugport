/** Synthetic durable records shared by runner instances in a test. */
export function memoryRecordStore() {
  const records = new Map<string, { id: string; owner: string; updatedAt: string; value: unknown }>();
  return {
    save(kind: string, id: string, owner: string, value: unknown, updatedAt = new Date().toISOString()) {
      records.set(`${kind}:${id}`, { id, owner, updatedAt, value: structuredClone(value) });
    },
    saveExpiring(
      kind: string,
      id: string,
      owner: string,
      value: unknown,
      budget: { now: number; keepMs: number; limit: number },
    ) {
      for (const row of this.entries(kind, owner))
        if (Date.parse(row.updatedAt) < budget.now - budget.keepMs) this.deleteRecord(kind, row.id);
      if (!this.get(kind, id) && this.entries(kind, owner).length >= budget.limit) return false;
      this.save(kind, id, owner, value, new Date(budget.now).toISOString());
      return true;
    },
    get: <T>(kind: string, id: string) => records.get(`${kind}:${id}`)?.value as T | undefined,
    entries: <T>(kind: string, owner: string) =>
      [...records]
        .filter(([key, row]) => key.startsWith(`${kind}:`) && row.owner === owner)
        .map(([, row]) => ({ ...row, value: row.value as T })),
    deleteRecord: (kind: string, id: string) => {
      records.delete(`${kind}:${id}`);
    },
  };
}
