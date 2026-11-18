import { EventEmitter } from 'node:events';
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { spawn } from './test-process.ts';

type CommandResult = { code: number | null; signal: NodeJS.Signals | null };
const wrappers = new WeakMap<ChildProcessWithoutNullStreams, PosixTask>();

// The group leader stays alive until it kills its own group, so its PGID cannot be recycled.
const posixTaskLauncher = String.raw`
const {spawn}=require('node:child_process');
const {connect}=require('node:net');
const [command,args,endpoint,token,electronAsNode]=JSON.parse(process.argv[1]);
let stopping=false, launched=false, socket;
const stop=()=>{
  if(stopping)return;
  stopping=true;
  try{process.kill(-process.pid,'SIGTERM')}catch{}
  setTimeout(()=>{process.kill(-process.pid,'SIGKILL')},500);
};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
process.on('disconnect',stop);
if(!process.connected)stop();
else {
  socket=connect(endpoint);
  socket.on('error',stop);
  socket.on('close',stop);
  const timeout=setTimeout(stop,10000);
  socket.on('connect',()=>socket.write(JSON.stringify({pid:process.pid,token})+'\n'));
  let input='';
  socket.on('data',bytes=>{
    input+=bytes.toString();
    if(input.length>4096)return stop();
    let at;
    while((at=input.indexOf('\n'))>=0){
      const line=input.slice(0,at);input=input.slice(at+1);
      if(line!=='go'||launched||stopping||!process.connected)return stop();
      launched=true;clearTimeout(timeout);
      const env={...process.env};
      delete env.PUGPORT_POSIX_GUARD_SOCKET;delete env.PUGPORT_POSIX_GUARD_TOKEN;
      if(electronAsNode===null)delete env.ELECTRON_RUN_AS_NODE;else env.ELECTRON_RUN_AS_NODE=electronAsNode;
      const child=spawn(command,args,{env,stdio:['inherit','inherit','inherit'],detached:false});
      child.once('spawn',()=>process.send?.({type:'task-started',pid:child.pid},()=>{}));
      child.once('error',error=>process.send?.({type:'task-error',code:error.code},stop));
      child.once('exit',(code,signal)=>process.send?.({type:'task-exit',code,signal},stop));
    }
  });
}
`;

export class PosixTask extends EventEmitter {
  readonly pid;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly stdio;
  readonly spawnfile;
  readonly spawnargs;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly connected = false;
  executorPid?: number;
  private result?: CommandResult;
  private started = false;
  private failed = false;
  cancelled = false;

  constructor(
    private readonly child: ChildProcess,
    command: string,
    args: string[],
  ) {
    super();
    this.pid = child.pid;
    this.stdin = child.stdin!;
    this.stdout = child.stdout!;
    this.stderr = child.stderr!;
    this.stdio = [this.stdin, this.stdout, this.stderr];
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    child.on('message', (input) => {
      const value = input as {
        type?: string;
        pid?: number;
        code?: number | string | null;
        signal?: NodeJS.Signals | null;
      };
      if (value.type === 'task-started') {
        if (Number.isSafeInteger(value.pid) && value.pid! > 0) this.executorPid = value.pid;
        this.started = true;
        this.emit('spawn');
      } else if (value.type === 'task-error') {
        this.failed = true;
        this.emit('error', Object.assign(new Error('runtime-process-closed'), { code: value.code }));
      } else if (value.type === 'task-exit' && (typeof value.code === 'number' || value.code === null)) {
        this.executorPid = undefined;
        this.result = { code: value.code, signal: value.signal ?? null };
      }
    });
    child.once('error', (error) => {
      this.failed = true;
      this.emit('error', error);
    });
    child.once('exit', (code, signal) => {
      this.executorPid = undefined;
      if (!this.started && !this.failed) this.emit('error', new Error('runtime-process-closed'));
      const result = this.cancelled ? undefined : this.result;
      this.exitCode = result ? result.code : code;
      this.signalCode = result ? result.signal : signal;
      this.emit('exit', this.exitCode, this.signalCode);
    });
    child.once('close', () => this.emit('close', this.exitCode, this.signalCode));
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.cancelled = true;
    this.killed = this.child.kill(signal);
    return this.killed;
  }
  ref() {
    this.child.ref();
  }
  unref() {
    this.child.unref();
  }
}

export function spawnPosixTask(command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
  const env = options.env ?? process.env;
  const child = spawn(
    process.execPath,
    [
      '-e',
      posixTaskLauncher,
      JSON.stringify([
        command,
        args,
        process.env.PUGPORT_POSIX_GUARD_SOCKET,
        process.env.PUGPORT_POSIX_GUARD_TOKEN,
        env.ELECTRON_RUN_AS_NODE ?? null,
      ]),
    ],
    { ...options, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
  );
  const task = new PosixTask(child, command, args);
  const result = task as unknown as ChildProcessWithoutNullStreams;
  wrappers.set(result, task);
  return result;
}

export function markPosixTaskCancelled(child: ChildProcessWithoutNullStreams) {
  const task = wrappers.get(child);
  if (task) task.cancelled = true;
}

export function posixTaskExecutorPid(child: ChildProcessWithoutNullStreams): number | undefined {
  return wrappers.get(child)?.executorPid;
}
