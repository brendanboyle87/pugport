export {};

declare global {
  interface Window {
    pugport: PugPortMod;
  }
  type ModSlot = 'mainView' | 'rightPanel' | 'sidebarPanel';
  type ModTheme = 'light' | 'dark';
  interface ModState {
    revision: number;
    values: Record<string, string>;
  }
  interface ModHostInfo {
    apiVersion: 2;
    hostVersion: string;
    locale: string;
    theme: ModTheme;
    tokens: Record<string, string>;
    slot: ModSlot;
    layout: 'workspace' | 'panel' | 'sidebar';
    conversation: { id: string; title: string };
    project?: { id: string; name: string };
  }
  interface ModMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    createdAt: string;
    attachments?: { name: string; kind: string }[];
  }
  type ModVoiceProvider = 'gpt-live' | 'local';
  type ModVoiceEvent = { sessionId: string; seq: number } & (
    | {
        kind: 'state';
        state: 'listening' | 'hearing' | 'speaking' | 'stopped';
        provider: ModVoiceProvider;
        reason?:
          'mod' | 'user' | 'hidden' | 'detached' | 'idle' | 'error' | 'limit' | 'interrupted' | 'fallback' | 'switched';
      }
    | { kind: 'transcript'; turn: number; role: 'user' | 'assistant'; text: string; final: boolean }
    | { kind: 'error'; code: 'E_MIC' | 'E_RECOGNITION' }
    | { kind: 'usage'; provider: ModVoiceProvider; seconds: number; costUsd: number }
  );
  type ModVoiceKind = 'state' | 'transcript' | 'usage' | 'error';
  /** Returned by voice.start: the session's own controls and events. */
  interface ModVoiceHandle {
    sessionId: string;
    provider: ModVoiceProvider;
    say(text: string): Promise<Record<string, never>>;
    instruct(text: string): Promise<Record<string, never>>;
    interrupt(): Promise<Record<string, never>>;
    stop(): Promise<Record<string, never>>;
    on<K extends ModVoiceKind>(kind: K, listener: (data: Extract<ModVoiceEvent, { kind: K }>) => void): () => void;
    on(kind: 'ended', listener: (data: Extract<ModVoiceEvent, { kind: 'state' }>) => void): () => void;
  }
  interface ModVoiceStatus {
    provider: ModVoiceProvider;
    available: boolean;
    gptLive: { available: boolean; reason?: 'setting' | 'no-card' | 'budget' | 'cooldown' | 'busy' };
  }
  interface ModModelEvent {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    text?: string;
    error?: 'E_FAILED' | 'E_FORMAT' | 'E_LIMIT' | 'E_CANCELLED';
    saveTo?: string;
  }
  interface ModStorageItem {
    key: string;
    value: string;
    updatedAt: string;
  }
  interface ModConnection {
    id: string;
    provider: 'plaid';
    environment: 'sandbox' | 'production';
    institution?: { id: string; name: string };
    status: 'connected' | 'syncing' | 'reauth_required' | 'error' | 'disconnected';
    lastSyncedAt?: string;
    lastAttemptAt?: string;
    nextSyncAt?: string;
    error?: { code: string; message: string };
    products: string[];
  }
  interface ModBankAccount {
    id: string;
    name: string;
    officialName?: string;
    mask?: string;
    type: string;
    subtype?: string;
    currency?: string;
    balances: { current?: number; available?: number; limit?: number; asOf?: string };
  }
  interface ModBankTransaction {
    id: string;
    accountId: string;
    date: string;
    authorizedDate?: string;
    name: string;
    merchantName?: string;
    /** Positive is money out of the account (a card purchase); negative is money in. */
    amount: number;
    currency?: string;
    pending: boolean;
    pendingTransactionId?: string;
    category?: string;
  }
  interface ModCreditLiability {
    accountId: string;
    lastStatementIssueDate?: string;
    lastStatementBalance?: number;
    minimumPaymentAmount?: number;
    nextPaymentDueDate?: string;
    lastPaymentAmount?: number;
    lastPaymentDate?: string;
    isOverdue?: boolean;
    aprs: { type: string; percentage: number }[];
  }
  type ModFileType = '.csv' | '.txt' | '.ofx' | '.qfx' | '.qif' | '.json' | '.pdf';
  interface ModEvents {
    ready: Record<string, never>;
    state: ModState;
    messages: { count: number; lastId?: string };
    run: { running: boolean };
    theme: { theme: ModTheme; tokens: Record<string, string> };
    visibility: { visible: boolean };
    chat: { open: boolean };
    detached: Record<string, never>;
    model: ModModelEvent;
    voice: ModVoiceEvent;
    connections: { connections: ModConnection[] };
  }
  interface ModError extends Error {
    code: 'E_INVALID' | 'E_PERMISSION' | 'E_CONFLICT' | 'E_UNAVAILABLE' | 'E_LIMIT';
  }
  interface PugPortMod {
    host: { info(): Promise<ModHostInfo> };
    state: {
      get(): Promise<ModState>;
      set(input: { values: Record<string, string>; expectedRevision: number }): Promise<ModState>;
    };
    messages: { list(input?: { limit?: number; before?: string }): Promise<ModMessage[]> };
    composer: { insert(input: { text: string; mode: 'append' | 'replace' }): Promise<Record<string, never>> };
    ui: {
      /** Open or close the real chat drawer. Available to workspace mainView only. */
      chat(input: { open: boolean }): Promise<Record<string, never>>;
      setDirty(dirty: boolean): Promise<Record<string, never>>;
      notify(message: string): Promise<Record<string, never>>;
    };
    model: {
      run(input: {
        prompt: string;
        saveTo?: string;
        format?: 'text' | 'json';
        fresh?: boolean;
      }): Promise<{ runId: string }>;
      cancel(input: { runId: string }): Promise<Record<string, never>>;
    };
    voice: {
      status(): Promise<ModVoiceStatus>;
      start(input?: {
        instructions?: string;
        language?: string;
        voice?: string;
        provider?: ModVoiceProvider;
        maxMinutes?: number;
        maxCostUsd?: number;
        endSilenceMs?: number;
      }): Promise<ModVoiceHandle>;
      speak(input: { sessionId: string; text: string }): Promise<Record<string, never>>;
      instruct(input: { sessionId: string; text: string }): Promise<Record<string, never>>;
      interrupt(input: { sessionId: string }): Promise<Record<string, never>>;
      stop(input: { sessionId: string }): Promise<Record<string, never>>;
    };
    storage: {
      get(input: { collection: string; keys: string[] }): Promise<{ items: ModStorageItem[] }>;
      put(input: { collection: string; items: { key: string; value: string }[] }): Promise<{ written: number }>;
      delete(input: { collection: string; keys: string[] }): Promise<{ deleted: number }>;
      list(input: {
        collection: string;
        prefix?: string;
        cursor?: string;
        limit?: number;
      }): Promise<{ items: ModStorageItem[]; cursor?: string }>;
      usage(): Promise<{
        items: number;
        bytes: number;
        quotaBytes: number;
        collections: { name: string; items: number }[];
      }>;
    };
    connections: {
      list(): Promise<{ connections: ModConnection[] }>;
      status(input: { connectionId: string }): Promise<ModConnection>;
      authorize(input: { provider: 'plaid' }): Promise<{ status: 'pending' }>;
      reconnect(input: { connectionId: string }): Promise<{ status: 'pending' }>;
      sync(input: { connectionId: string }): Promise<ModConnection>;
      accounts(input: { connectionId: string }): Promise<{ accounts: ModBankAccount[] }>;
      transactions(input: { connectionId: string; cursor?: string; limit?: number; accountId?: string }): Promise<{
        changes: { seq: number; removed: boolean; transaction: ModBankTransaction | { id: string } }[];
        cursor: string;
        hasMore: boolean;
      }>;
      liabilities(input: { connectionId: string }): Promise<{ credit: ModCreditLiability[] }>;
    };
    files: {
      pick(input: {
        accept: ModFileType[];
      }): Promise<{ fileId: string; name: string; size: number; type: string } | { cancelled: true }>;
      readText(input: {
        fileId: string;
        offset?: number;
      }): Promise<{ text: string; length: number; nextOffset?: number }>;
      pdfText(input: {
        fileId: string;
        fromPage?: number;
      }): Promise<{ pageCount: number; pages: { page: number; text: string }[]; nextPage?: number }>;
    };
    on<K extends keyof ModEvents>(event: K, listener: (data: ModEvents[K]) => void): () => void;
  }
}
