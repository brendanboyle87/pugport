export type HindsightSettings = {
  enabled: boolean;
  pythonExecutable: string;
  runtimeId: string;
  projectIds: string[];
  dailyModelCalls: number;
  recallTimeoutMs: number;
};

export const defaultHindsightSettings: HindsightSettings = {
  enabled: false,
  pythonExecutable: '',
  runtimeId: '',
  projectIds: [],
  dailyModelCalls: 20,
  recallTimeoutMs: 1200,
};

export type HindsightRuntimeStatus = {
  state: 'disabled' | 'starting' | 'ready' | 'unavailable';
  detail?: string;
  version?: string;
};
