export const idleMachineReading = () => ({
  cpus: 8,
  totalBytes: 32 * 1024 ** 3,
  freeBytes: 24 * 1024 ** 3,
  availableMemoryBytes: 24 * 1024 ** 3,
  sampledAt: Date.now(),
  cpuPercent: 10,
  pressure: false,
  cpuBusy: false,
  memoryBusy: false,
});
