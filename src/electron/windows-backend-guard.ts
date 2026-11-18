import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export type BackendGuard = {
  /** The original backend process has been assigned to a no-breakaway, kill-on-close job. */
  ready: Promise<void>;
  /** The job reports zero active processes and the separate guardian has exited successfully. */
  closed: Promise<void>;
  terminate: () => Promise<void>;
};
type GuardOptions = {
  desktopPid?: number;
  nonce?: string;
  startupMs?: number;
  cleanupMs?: number;
  launch?: (script: string) => ChildProcess;
};

/** Unnamed, non-inheritable job: only the separate guardian holds its handle. */
export function windowsBackendGuardScript(pid: number, desktopPid: number, nonce: string): string {
  if (![pid, desktopPid].every((id) => Number.isSafeInteger(id) && id > 0) || !/^[a-f0-9]{32}$/.test(nonce))
    throw Error('后台进程保护参数不可用。');
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class PugPortBackendGuard {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low; public uint High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessTime; public long PerJobTime; public uint Flags; public UIntPtr MinWorkingSet; public UIntPtr MaxWorkingSet; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority; public uint Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations; public ulong WriteOperations; public ulong OtherOperations; public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory; public UIntPtr JobMemory; public UIntPtr PeakProcessMemory; public UIntPtr PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime; public long KernelTime; public long PeriodUserTime; public long PeriodKernelTime; public uint PageFaults; public uint TotalProcesses; public uint ActiveProcesses; public uint TerminatedProcesses; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting data, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateEvent(IntPtr attributes, bool manual, bool initial, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEvent(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Send(string type, int pid, string nonce, string birth, uint active) {
    Console.Out.WriteLine("{\\"type\\":\\""+type+"\\",\\"pid\\":"+pid+",\\"nonce\\":\\""+nonce+"\\",\\"birth\\":\\""+birth+"\\",\\"active\\":"+active+"}"); Console.Out.Flush();
  }
  public static void Run(int pid, int desktopPid, string nonce) {
    IntPtr root=IntPtr.Zero, desktop=IntPtr.Zero, job=IntPtr.Zero, control=IntPtr.Zero;
    bool assigned=false;
    try {
      root=OpenProcess(0x101101, false, pid); Check(root!=IntPtr.Zero);
      desktop=OpenProcess(0x100000, false, desktopPid); Check(desktop!=IntPtr.Zero);
      FileTime birth, exit, kernel, user; Check(GetProcessTimes(root,out birth,out exit,out kernel,out user));
      string identity=birth.Value.ToString();
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      ExtendedLimits limits=new ExtendedLimits(); limits.Basic.Flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      Send("opened",pid,nonce,identity,0);
      // Desktop first challenges its original fork's IPC channel with this handle's
      // birth time. A recycled PID cannot answer on that original IPC connection.
      string command=Console.In.ReadLine();
      if(command!="assign:"+nonce+":"+identity) throw new InvalidOperationException("identity challenge not confirmed");
      if(WaitForSingleObject(root,0)!=258 || WaitForSingleObject(desktop,0)!=258) throw new InvalidOperationException("owner exited before containment");
      Check(AssignProcessToJobObject(job,root)); assigned=true;
      control=CreateEvent(IntPtr.Zero,true,false,null); Check(control!=IntPtr.Zero);
      Send("contained",pid,nonce,identity,0);
      IntPtr stop=control;
      Thread reader=new Thread(delegate() { try { Console.In.ReadLine(); } finally { SetEvent(stop); } });
      reader.IsBackground=true; reader.Start();
      uint waited=WaitForMultipleObjects(3,new IntPtr[]{root,desktop,control},false,0xffffffff);
      if(waited>2) throw new Win32Exception(Marshal.GetLastWin32Error());
      Check(TerminateJobObject(job,1));
      var deadline=DateTime.UtcNow.AddSeconds(8);
      Accounting accounting;
      do {
        Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
        if(accounting.ActiveProcesses==0) break;
        if(DateTime.UtcNow>=deadline) throw new TimeoutException("job still has active processes");
        Thread.Sleep(20);
      } while(true);
      Check(CloseHandle(job)); job=IntPtr.Zero;
      Send("cleaned",pid,nonce,identity,0);
    } catch(Exception error) {
      Console.Error.WriteLine("PugPort backend containment failed: "+error.Message);
      Environment.ExitCode=1;
    } finally {
      // Killing or crashing the guardian also closes the last job handle in the OS.
      if(job!=IntPtr.Zero) { if(assigned) TerminateJobObject(job,1); CloseHandle(job); }
      if(control!=IntPtr.Zero) CloseHandle(control);
      if(root!=IntPtr.Zero) CloseHandle(root);
      if(desktop!=IntPtr.Zero) CloseHandle(desktop);
    }
  }
}
'@; [PugPortBackendGuard]::Run(${pid},${desktopPid},'${nonce}'); exit [Environment]::ExitCode`;
}

/** Own only the supplied fork and a newly spawned guardian; never discover another server by PID or name. */
export function createWindowsBackendGuard(child: ChildProcess, options: GuardOptions = {}): BackendGuard {
  const pid = child.pid;
  if (!pid) throw Error('后台进程尚未启动，无法建立进程保护。');
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const script = windowsBackendGuardScript(pid, options.desktopPid ?? process.pid, nonce);
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const ready = new Promise<void>((done, reject) => {
    resolveReady = done;
    rejectReady = reject;
  });
  const closed = new Promise<void>((done, reject) => {
    resolveClosed = done;
    rejectClosed = reject;
  });
  void ready.catch(() => {});
  void closed.catch(() => {});
  let guardian: ChildProcess | undefined;
  let birth = '';
  let assigned = false;
  let assignSent = false;
  let cleaned = false;
  let failed = false;
  let ended = false;
  let output = '';
  const error = () => new Error('后台进程保护或子进程清理未完成；本次不会启动任务或自动恢复。');
  const cleanupListeners = () => child.off('message', message);
  const fail = () => {
    if (failed || ended) return;
    failed = true;
    clearTimeout(timer);
    cleanupListeners();
    rejectReady(error());
    rejectClosed(error());
    // Only the exact guardian child handle is stopped. Its kill-on-close job
    // handles assigned descendants; before assignment the bootstrap has no children.
    guardian?.kill();
    if (!assigned && child.exitCode === null && child.signalCode === null) child.kill();
  };
  const send = (value: Record<string, unknown>) => {
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) return fail();
    try {
      child.send(value, (error) => {
        if (error) fail();
      });
    } catch {
      fail();
    }
  };
  const write = (value: string) => {
    if (!guardian?.stdin || guardian.stdin.destroyed) return fail();
    guardian.stdin.write(value + '\n');
  };
  const receive = (line: string) => {
    if (failed || ended) return;
    let value: { type?: string; pid?: number; nonce?: string; birth?: string; active?: number };
    try {
      value = JSON.parse(line);
    } catch {
      return fail();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    if (
      value.pid !== pid ||
      value.nonce !== nonce ||
      typeof value.birth !== 'string' ||
      !/^\d{16,20}$/.test(value.birth)
    )
      return fail();
    if (value.type === 'opened' && !birth && !assigned) {
      birth = value.birth;
      send({ type: 'containment-challenge', nonce, birth });
    } else if (value.type === 'contained' && value.birth === birth && assignSent && !assigned) {
      assigned = true;
      clearTimeout(timer);
      cleanupListeners();
      resolveReady();
      send({ type: 'containment-go', nonce });
    } else if (value.type === 'cleaned' && assigned && value.birth === birth && value.active === 0) cleaned = true;
    else fail();
  };
  const message = (input: unknown) => {
    const value = input as { type?: string; nonce?: string; birth?: string };
    if (!value || failed || ended) return;
    if (value.type === 'containment-bootstrap' && !guardian) {
      try {
        guardian =
          options.launch?.(script) ??
          spawn(
            join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
          );
        guardian.stdin?.on('error', fail);
        guardian.stderr?.resume();
        guardian.stdout?.on('data', (bytes: Buffer) => {
          output += bytes.toString('utf8');
          if (output.length > 65536) return fail();
          let at: number;
          while ((at = output.indexOf('\n')) >= 0) {
            const line = output.slice(0, at).trim();
            output = output.slice(at + 1);
            if (line) receive(line);
          }
        });
        guardian.once('error', fail);
        guardian.once('close', (code) => {
          if (ended) return;
          clearTimeout(timer);
          cleanupListeners();
          if (code === 0 && cleaned && !failed) {
            ended = true;
            resolveClosed();
          } else fail();
        });
      } catch {
        fail();
      }
    } else if (value.type === 'containment-challenge-ack' && guardian && !assigned) {
      if (value.nonce !== nonce || value.birth !== birth || !birth) return fail();
      if (!assignSent) {
        assignSent = true;
        write('assign:' + nonce + ':' + birth);
      }
    }
  };
  const timer = setTimeout(fail, options.startupMs ?? 35000);
  child.on('message', message);
  const waitForOwnedExit = (process: ChildProcess | undefined) => {
    if (!process || process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
    return new Promise<void>((done) => process.once('exit', () => done()));
  };
  return {
    ready,
    closed,
    terminate: async () => {
      if (ended) return closed;
      let timeout: NodeJS.Timeout | undefined;
      // A broken guardian may not supply a clean acknowledgement. It cannot grant
      // automatic recovery (closed stays rejected), but quitting can still wait
      // for the exact guardian handle and original backend handle to terminate.
      // The unnamed job's only handle dies with that guardian; a bootstrap which
      // never entered the job was never allowed to import the server at all.
      if (!assigned || failed) fail();
      else write('terminate');
      const stopped = failed
        ? Promise.all([waitForOwnedExit(guardian), waitForOwnedExit(child)]).then(() => {})
        : closed;
      try {
        await Promise.race([
          stopped,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              fail();
              reject(error());
            }, options.cleanupMs ?? 10000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
