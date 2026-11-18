export type ProjectPurgePreview = {
  projectId: string;
  name: string;
  token: string;
  conversations: number;
  attachments: number;
  managedFiles: number;
  managedBytes: number;
  preservedProjectPath: string;
  managedWorkspacePath?: string;
  canPurge: boolean;
  blockedReason?: string;
  partial: boolean;
  scheduledTasks?: number;
};

export type ProjectPurgeResult = {
  projectId: string;
  conversations: number;
  attachments: number;
  deletedFiles: number;
  freedBytes: number;
  sharedFilesKept: number;
  databaseSpace: 'reusable';
  warnings?: string[];
  scheduledTasks?: number;
};
