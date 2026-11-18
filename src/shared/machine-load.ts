export const machineLoadReasons = {
  cpu: '电脑繁忙（CPU 超过 85%），排队中',
  memory: '内存不足（可用内存低于 2 GB），排队中',
} as const;

/** The same cached reading and capacity counts used at one admission check. */
export type MachineLoadObservation = {
  evaluatedAt: string;
  sourceSampledAt?: string;
  sampleFresh: boolean;
  cpuPercent?: number;
  cpuThresholdPercent: number;
  availableMemoryBytes?: number;
  memoryReserveBytes: number;
  firstRunHeadroomBytes: number;
  /** First foreground conversation floor, independent of the ordinary multi-run reserve. */
  idleChatMemoryBytes: number;
  cpuBusy: boolean;
  memoryBusy: boolean;
  processLimit: number;
  processes: number;
  executions: number;
  pendingStarts: number;
  returningTurns: number;
  userLimit: number;
  idleChatAvailable: boolean;
  idleChatAdmitted?: boolean;
};
