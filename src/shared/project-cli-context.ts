export type RemoteParamType = 'sha' | 'branch' | 'relpath' | 'word' | 'int';

export type ProjectSshQuery = {
  name: string;
  host: string;
  /** User-approved executable and arguments; only declared whole-element parameters may vary. */
  argv: string[];
  timeoutSeconds?: number;
  params?: Record<string, RemoteParamType>;
  push?: { repository: string; refs: string[] };
  cwd?: string;
  background?: true;
  readOnly?: true;
};

export type ProjectCliContext = {
  projectId: string;
  revision: number;
  autoMemoryDirectory?: string;
  sshQueries: ProjectSshQuery[];
};

export type ProjectCliContextUpdate = {
  revision: number;
  autoMemoryDirectory: string | null;
  sshQueries: ProjectSshQuery[];
};

export type ProjectQueryResult = {
  name: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'output-limit';
  exitCode?: number;
  stdout: string;
  stderr: string;
  /** Ending the local SSH connection does not prove the remote process stopped. */
  remoteMayContinue?: boolean;
};

export type RemoteJobResult = {
  jobId: string;
  name: string;
  host: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'busy' | 'push-failed';
  exitCode?: number;
  resultLines: string[];
  outputTail: string;
  startedAt: string;
  endedAt?: string;
  remoteMayContinue?: boolean;
  error?: string;
};
