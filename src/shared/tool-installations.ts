export const installableToolIds = ['voice', 'image-search', 'memory-search', 'markitdown'] as const;
export type InstallableToolId = (typeof installableToolIds)[number];
export type ToolInstallation = {
  id: string;
  tool: InstallableToolId;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  phase: 'preparing' | 'downloading' | 'verifying' | 'installing' | 'completed' | 'failed' | 'interrupted';
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  receivedBytes?: number;
  totalBytes?: number;
};
