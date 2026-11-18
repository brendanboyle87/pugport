import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

type ProcessIdentity = { pid: number; parentPid: number; createdAt: string };
type TreeOperations = {
  snapshot: (timeoutMs: number) => Promise<ProcessIdentity[]>;
  terminateVerified?: (identities: ProcessIdentity[], timeoutMs: number) => Promise<void>;
  waitMs?: number;
  snapshotTimeoutMs?: number;
  terminationTimeoutMs?: number;
  budgetMs?: number;
  now?: () => number;
};
export const WINDOWS_BACKEND_CLEANUP_TIMEOUT_MS = 40_000;
// PowerShell/CIM cold startup can exceed eight seconds on a busy Windows host.
// Each helper stays bounded, and all helpers share one shorter-than-desktop budget.
const snapshotTimeoutMs = 15_000;
const terminationTimeoutMs = 8_000;
const cleanupBudgetMs = WINDOWS_BACKEND_CLEANUP_TIMEOUT_MS - 2000;
const observedTrees = new WeakMap<ChildProcess, { root: ProcessIdentity; descendants: ProcessIdentity[] }>();
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      done(exited(child));
    };
    const timer = setTimeout(finish, ms);
    child.once('exit', finish);
  });
}

const windowsRoot = () => process.env.SystemRoot || 'C:\\Windows';
export const nativeOperations: TreeOperations = {
  snapshot: (timeoutMs) =>
    new Promise((done, reject) => {
      // No command lines, credentials or executable-name matching. Creation time prevents a
      // reused PID (or a historical ParentProcessId) from becoming a new cleanup target.
      const script = `$ErrorActionPreference='Stop'; $result=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { if ($_.CreationDate) { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;createdAt=$_.CreationDate.ToUniversalTime().Ticks.ToString()} } }); ConvertTo-Json -InputObject $result -Compress`;
      execFile(
        join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error)
            return reject(
              new Error(error.killed ? '无法核对自有后台子进程（检查超时，请稍后重试）。' : '无法核对自有后台子进程。'),
            );
          try {
            const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
            if (!Array.isArray(rows)) throw Error();
            const result = rows.filter(
              (row): row is ProcessIdentity =>
                !!row &&
                Number.isSafeInteger(row.pid) &&
                Number.isSafeInteger(row.parentPid) &&
                typeof row.createdAt === 'string' &&
                /^\d+$/.test(row.createdAt),
            );
            if (result.length !== rows.length) throw Error();
            done(result);
          } catch {
            reject(new Error('无法核对自有后台子进程。'));
          }
        },
      );
    }),
  terminateVerified: (identities, timeoutMs) =>
    new Promise((done, reject) => {
      // Acquire a handle to the observed process and compare its birth time before killing
      // that handle. CIM timestamps have microsecond precision; StartTime has 100 ns ticks.
      // Check a deadline in the helper too: a busy Node event loop must not let a
      // delayed execFile timeout leave PowerShell initiating further terminations.
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
      const script = `$ErrorActionPreference='Stop'; $deadline=[DateTime]::Parse('${expiresAt}').ToUniversalTime(); $targets=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $failed=$false; foreach($identity in $targets) {if([DateTime]::UtcNow -ge $deadline){$failed=$true;break}; try {$target=[Diagnostics.Process]::GetProcessById([int]$identity.pid)} catch [ArgumentException] {continue}; try {$null=$target.Handle; $birth=$target.StartTime.ToUniversalTime().Ticks; if (($birth-($birth % 10)).ToString() -ne [string]$identity.createdAt) {continue}; if([DateTime]::UtcNow -ge $deadline){$failed=$true;break}; $target.Kill(); $waitMs=[int][Math]::Max(1,[Math]::Min(1500,($deadline-[DateTime]::UtcNow).TotalMilliseconds)); if (!$target.WaitForExit($waitMs)) {$failed=$true}} catch {$failed=$true} finally {$target.Dispose()}}; if($failed) {exit 1}`;
      const helper = execFile(
        join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 },
        (error) => (error ? reject(new Error('部分自有子进程仍未停止。')) : done()),
      );
      helper.stdin?.on('error', () => {});
      helper.stdin?.end(JSON.stringify(identities));
    }),
};

function descendants(rows: ProcessIdentity[], pid: number): ProcessIdentity[] {
  const root = rows.find((row) => row.pid === pid);
  if (!root) return [];
  const tree = [root];
  for (let i = 0; i < tree.length; i++)
    for (const row of rows)
      if (
        row.parentPid === tree[i].pid &&
        BigInt(row.createdAt) >= BigInt(tree[i].createdAt) &&
        !tree.some((entry) => entry.pid === row.pid)
      )
        tree.push(row);
  return tree.slice(1);
}

/** The supplied object must be the ChildProcess this desktop forked, never an HTTP-discovered PID. */
export async function terminateWindowsBackend(
  child: ChildProcess,
  operations = nativeOperations,
  budgetMs = operations.budgetMs ?? cleanupBudgetMs,
): Promise<void> {
  if (!child.pid) return;
  const now = operations.now ?? (() => performance.now());
  const deadline = now() + budgetMs;
  const remainingBudget = (maximum: number) => {
    const left = deadline - now();
    if (left <= 0) throw new Error('核对和清理自有后台进程树超时；请稍后重试退出。');
    return Math.max(1, Math.floor(Math.min(maximum, left)));
  };
  const snapshot = async () => {
    const rows = await operations.snapshot(remainingBudget(operations.snapshotTimeoutMs ?? snapshotTimeoutMs));
    // A delayed callback must not grant permission to terminate after the shared
    // budget has expired, even if its result itself is a valid process snapshot.
    remainingBudget(snapshotTimeoutMs);
    return rows;
  };
  let observed = observedTrees.get(child);
  if (!observed) {
    if (exited(child)) return;
    const before = await snapshot();
    // The root could exit and its PID be reused while the snapshot helper starts. No newly
    // observed tree is trusted after the original child handle reports an exit.
    if (exited(child)) return;
    const root = before.find((row) => row.pid === child.pid);
    if (!root) throw new Error('无法核对自有后台子进程。');
    observed = { root, descendants: descendants(before, child.pid) };
    observedTrees.set(child, observed);
  }
  const tree = observed.descendants;
  let current = await snapshot();
  if (!exited(child) && current.some((row) => row.pid === child.pid && row.createdAt === observed.root.createdAt))
    for (const row of descendants(current, child.pid))
      if (!tree.some((owned) => owned.pid === row.pid && owned.createdAt === row.createdAt)) tree.push(row);
  // Also capture new descendants of still-live, identity-verified children if their root
  // has already exited. A reused PID cannot establish this relationship.
  for (const owned of [...tree])
    if (current.some((live) => live.pid === owned.pid && live.createdAt === owned.createdAt))
      for (const row of descendants(current, owned.pid))
        if (!tree.some((entry) => entry.pid === row.pid && entry.createdAt === row.createdAt)) tree.push(row);
  const liveDescendants = () =>
    tree.filter((owned) => current.some((live) => live.pid === owned.pid && live.createdAt === owned.createdAt));
  let remaining = liveDescendants();
  if (remaining.length && operations.terminateVerified) {
    // Leaves first. Every fallback rechecks the creation time against its actual process
    // handle; it never acts on an unverified PID or on an executable name.
    const timeoutMs = remainingBudget(operations.terminationTimeoutMs ?? terminationTimeoutMs);
    await operations.terminateVerified(remaining.reverse(), timeoutMs).catch(() => {});
    current = await snapshot();
    remaining = liveDescendants();
  }
  if (remaining.length)
    throw new Error(`自有后台子进程仍未停止（PID ${remaining.map((row) => row.pid).join('、')}）；请稍后重试退出。`);
  if (!exited(child)) {
    // Only after every observed descendant is gone: use the original process handle when
    // terminating the backend. Never abandon known live descendants by killing only their parent.
    const waitMs = remainingBudget(operations.waitMs ?? 1500);
    try {
      child.kill('SIGKILL');
    } catch {
      /* The exit event below remains the authority; kill() returning true is not completion. */
    }
    if (!(await waitForExit(child, waitMs))) {
      throw new Error(`自有后台进程仍未停止（PID ${child.pid}）。`);
    }
  }
  observedTrees.delete(child);
}
