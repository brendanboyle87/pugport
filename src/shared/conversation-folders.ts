/** Chat folders are independent of filesystem projects. */
export const conversationFolderNameKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

export type ConversationFolder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ClassificationProposal = {
  conversationId: string;
  title: string;
  folderName?: string;
  suggestedTitle?: string;
  previousFolderId?: string;
};

export type ClassificationJob = {
  id: string;
  status: 'running' | 'applied' | 'undone' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  /** Chats whose title or category actually changed. */
  changed: number;
  renamed: number;
  createdFolders: number;
  skipped: number;
  proposals: ClassificationProposal[];
  runIds: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Conversations restored by undo; later manual changes are left alone. */
  undoneCount?: number;
};

export type ClassificationOptions = {
  /** Idempotency key for a single organize request. */
  requestId?: string;
  /** Explicitly opt in to reorganizing chats already filed by the user. */
  includeFiled?: boolean;
};
