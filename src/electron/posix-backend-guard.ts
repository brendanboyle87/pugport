import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { BackendGuard } from './windows-backend-guard.ts';

/** Only task launchers can kill their own held groups. Desktop cleanup never signals stored task PIDs. */
export function createPosixBackendGuard(child: ChildProcess): BackendGuard {
  const token = randomBytes(16).toString('hex');
  const tasks = new Map<Socket, number>();
  const sockets = new Set<Socket>();
  let directory = '';
  let stopping = false;
  let cancelBootstrap = () => {};
  let failed: Error | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((done, reject) => {
    resolveClosed = done;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  const server = createServer((socket) => {
    sockets.add(socket);
    let input = '';
    let registered = false;
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      input += bytes.toString();
      if (input.length > 4096) return socket.destroy();
      let at: number;
      while ((at = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, at);
        input = input.slice(at + 1);
        let value: { pid?: number; token?: string };
        try {
          value = JSON.parse(line);
        } catch {
          return socket.destroy();
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return socket.destroy();
        if (!registered) {
          if (stopping || value.token !== token || !Number.isSafeInteger(value.pid) || value.pid! <= 0)
            return socket.destroy();
          registered = true;
          tasks.set(socket, value.pid!);
          socket.write('go\n');
        } else socket.destroy();
      }
    });
    socket.once('close', () => {
      sockets.delete(socket);
      const pid = tasks.get(socket);
      if (!pid) return;
      void waitGroupGone(pid)
        .then(() => {
          tasks.delete(socket);
        })
        .catch((error: Error) => {
          failed = error;
        });
    });
  });
  let cleanup: Promise<void> | undefined;
  const stop = () =>
    (cleanup ??= (async () => {
      stopping = true;
      cancelBootstrap();
      await ready.catch(() => {});
      for (const socket of tasks.keys()) socket.end('stop\n');
      for (const socket of sockets) if (!tasks.has(socket)) socket.destroy();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      const until = Date.now() + 5000;
      while (tasks.size || (child.exitCode === null && child.signalCode === null)) {
        if (failed) throw failed;
        if (Date.now() >= until) throw new Error('后台子进程清理未确认。');
        await new Promise((done) => setTimeout(done, 25));
      }
      if (failed) throw failed;
    })()
      .finally(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
        if (directory) await rm(directory, { recursive: true, force: true });
      })
      .then(resolveClosed, (error) => {
        rejectClosed(error);
        throw error;
      }));
  const bootstrap = new Promise<void>((done, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);
      if (error) reject(error);
      else done();
    };
    const message = (value: unknown) => {
      if ((value as { type?: string })?.type === 'posix-containment-bootstrap') finish();
    };
    const exited = () => finish(new Error('后台进程保护启动已取消。'));
    cancelBootstrap = exited;
    const timer = setTimeout(() => finish(new Error('后台进程保护启动超时。')), 10000);
    child.on('message', message);
    child.once('exit', exited);
  });
  void bootstrap.catch(() => {});
  const ready = (async () => {
    directory = await mkdtemp('/tmp/pugport-guard-');
    const path = join(directory, 'tasks.sock');
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(path, done);
    });
    await bootstrap;
    if (stopping || !child.connected) throw new Error('后台进程保护启动已取消。');
    child.send({ type: 'posix-containment-go', path, token });
  })();
  void ready.catch(() => {
    void stop().catch(() => {});
  });
  child.once('exit', () => {
    void stop().catch(() => {});
  });
  return { ready, closed, terminate: stop };
}

async function waitGroupGone(pid: number) {
  const until = Date.now() + 3000;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    if (Date.now() >= until) throw new Error('后台子进程组仍未停止。');
    await new Promise((done) => setTimeout(done, 25));
  }
}
