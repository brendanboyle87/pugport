import { execFile } from './platform/test-process.ts';

export type GitRunner = (
  cwd: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; maxBuffer?: number },
) => Promise<string | undefined>;

function gitEnv() {
  // GIT_OPTIONAL_LOCKS=0: git status must not take the index lock an executor's own git may need.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_NO_LAZY_FETCH: '1',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'])
    delete env[name];
  return env;
}
export type GitCapture = { exitCode: number; stdout: string; stderr: string; truncated: boolean };
export const captureGit = (
  cwd: string,
  args: string[],
  { timeoutMs, signal, maxBuffer }: { timeoutMs: number; signal?: AbortSignal; maxBuffer?: number },
): Promise<GitCapture> =>
  new Promise((done) => {
    if (signal?.aborted) return done({ exitCode: 1, stdout: '', stderr: 'Git command cancelled.', truncated: false });
    let settled = false;
    let answered = false;
    let closed = false;
    let output: GitCapture = { exitCode: 1, stdout: '', stderr: 'Git command did not finish.', truncated: false };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(output);
    };
    // execFile's own timeout kills git; this one also answers if that kill hangs (antivirus, Windows).
    const timer = setTimeout(finish, timeoutMs + 1000);
    timer.unref?.();
    try {
      const child = execFile(
        'git',
        args,
        {
          cwd,
          env: gitEnv(),
          timeout: timeoutMs,
          maxBuffer: maxBuffer ?? 16 * 1024 * 1024,
          windowsHide: true,
          signal,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          output = {
            exitCode: error
              ? typeof error.code === 'number'
                ? error.code
                : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                  ? 0
                  : 1
              : 0,
            stdout,
            stderr:
              stderr ||
              (error && typeof error.code !== 'number' && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'Git command failed or was cancelled.'
                : ''),
            truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          };
          answered = true;
          // A stopped git is answered for before it has exited, and until then it holds the project folder
          // (Windows cannot remove it). Wait for exit and closed pipes, unless git never started.
          if (closed || child.pid === undefined) finish();
        },
      );
      child.stdin?.end();
      child.once('close', () => {
        closed = true;
        if (answered) finish();
      });
    } catch {
      finish();
    }
  });

export const runGit: GitRunner = async (cwd, args, options) => {
  const result = await captureGit(cwd, ['-c', 'core.quotepath=false', ...args], options);
  return result.exitCode === 0 && !result.truncated ? result.stdout : undefined;
};
