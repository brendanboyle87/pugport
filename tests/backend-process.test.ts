import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { nativeOperations, terminateWindowsBackend } from '../src/electron/backend-process.ts';
import { closeExecutionResources } from '../src/server/shutdown.ts';

class Child extends EventEmitter {
  pid = 110;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills = 0;
  finish() {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
  kill() {
    this.kills++;
    this.finish();
    return true;
  }
  handle() {
    return this as unknown as ChildProcess;
  }
}
const root = { pid: 110, parentPid: 100, createdAt: '200' };
const descendant = { pid: 120, parentPid: 110, createdAt: '210' };

test('a natural backend exit during process inspection is successful after checking descendants', async () => {
  const child = new Child();
  let calls = 0;
  await terminateWindowsBackend(child.handle(), {
    snapshot: async () => {
      if (++calls === 1) return [root];
      child.finish();
      return [];
    },
    waitMs: 30,
  });
  assert.equal(child.kills, 0);
  assert.equal(calls, 2);
});

test('the original child handle is stopped only after the subtree is gone', async () => {
  const child = new Child();
  let calls = 0;
  await terminateWindowsBackend(child.handle(), {
    snapshot: async () => (++calls === 1 ? [root, descendant] : [root]),
    waitMs: 1,
  });
  assert.equal(child.kills, 1);
  assert.equal(child.exitCode, 0);
});

test('live descendant blocks completion even when root exited; retry checks it again', async () => {
  const child = new Child();
  let snapshots = 0;
  const operations = {
    snapshot: async () => {
      if (++snapshots === 1) return [root, descendant];
      child.finish();
      return snapshots < 3 ? [descendant] : [];
    },
    waitMs: 1,
  };
  await assert.rejects(terminateWindowsBackend(child.handle(), operations), /子进程仍未停止.*120/);
  assert.equal(child.kills, 0);
  await terminateWindowsBackend(child.handle(), operations);
  assert.equal(snapshots, 3);
});

test('historical parent IDs and reused descendant PIDs never become kill targets', async () => {
  const child = new Child();
  let calls = 0;
  const requests: number[] = [];
  await terminateWindowsBackend(child.handle(), {
    snapshot: async () => {
      if (++calls === 1) return [root, descendant, { pid: 130, parentPid: root.pid, createdAt: '100' }];
      child.finish();
      return [
        { ...descendant, parentPid: 999, createdAt: '999' },
        { pid: 130, parentPid: root.pid, createdAt: '100' },
      ];
    },
    terminateVerified: async (identities) => {
      requests.push(...identities.map((identity) => identity.pid));
    },
    waitMs: 1,
  });
  assert.deepEqual(requests, []);
  assert.equal(child.kills, 0);
});

test('retry stops an identity-verified orphan instead of requiring it to quit by itself', async () => {
  const child = new Child();
  let alive = true;
  let fallbackAllowed = false;
  let snapshots = 0;
  const requests: number[] = [];
  const operations = {
    snapshot: async () => {
      if (++snapshots > 1) child.finish();
      return [root, ...(alive ? [descendant] : [])];
    },
    terminateVerified: async (identities: (typeof descendant)[]) => {
      requests.push(...identities.map((identity) => identity.pid));
      if (!fallbackAllowed) throw Error('fixture temporary denial');
      alive = false;
    },
    waitMs: 1,
  };
  await assert.rejects(terminateWindowsBackend(child.handle(), operations), /子进程仍未停止/);
  fallbackAllowed = true;
  await terminateWindowsBackend(child.handle(), operations);
  assert.deepEqual(requests, [descendant.pid, descendant.pid]);
  assert.equal(child.kills, 0);
});

test('root exit during the first snapshot never adopts a potentially reused PID tree', async () => {
  const child = new Child();
  await terminateWindowsBackend(child.handle(), {
    snapshot: async () => {
      child.finish();
      return [root, descendant];
    },
    terminateVerified: async () => assert.fail('cannot trust a tree first seen after the root exited'),
  });
  assert.equal(child.kills, 0);
});

test('children launched during the termination attempt still block direct parent-only fallback', async () => {
  const child = new Child();
  let calls = 0;
  await assert.rejects(
    terminateWindowsBackend(child.handle(), {
      snapshot: async () => (++calls === 1 ? [root] : [root, descendant]),
      waitMs: 1,
    }),
    /子进程仍未停止/,
  );
  assert.equal(child.kills, 0);
});

test('unverifiable process ownership and a still-live process are never reported as stopped', async () => {
  const child = new Child();
  await assert.rejects(
    terminateWindowsBackend(child.handle(), {
      snapshot: async () => [],
      waitMs: 1,
    }),
    /无法核对/,
  );
  child.kill = () => true;
  await assert.rejects(
    terminateWindowsBackend(child.handle(), {
      snapshot: async () => [root],
      waitMs: 1,
    }),
    /自有后台进程仍未停止/,
  );
});

test('a cold process snapshot can take longer than eight seconds without weakening identity checks', async () => {
  const child = new Child();
  let elapsed = 0;
  const timeouts: number[] = [];
  await terminateWindowsBackend(child.handle(), {
    now: () => elapsed,
    snapshot: async (timeoutMs) => {
      timeouts.push(timeoutMs);
      elapsed += timeouts.length === 1 ? 9000 : 500;
      return [root];
    },
    waitMs: 1,
  });
  assert.deepEqual(timeouts, [15_000, 15_000]);
  assert.equal(child.kills, 1);
});

test('snapshot and verified-handle helpers share the remaining overall cleanup budget', async () => {
  const child = new Child();
  let elapsed = 0;
  let calls = 0;
  const budgets: [string, number][] = [];
  await terminateWindowsBackend(child.handle(), {
    now: () => elapsed,
    budgetMs: 38_000,
    snapshot: async (timeoutMs) => {
      budgets.push(['snapshot', timeoutMs]);
      elapsed += ++calls <= 2 ? 14_000 : 500;
      return calls <= 2 ? [root, descendant] : [root];
    },
    terminateVerified: async (targets, timeoutMs) => {
      assert.deepEqual(targets, [descendant]);
      budgets.push(['terminate', timeoutMs]);
      elapsed += 7000;
    },
    waitMs: 1,
  });
  assert.deepEqual(budgets, [
    ['snapshot', 15_000],
    ['snapshot', 15_000],
    ['terminate', 8000],
    ['snapshot', 3000],
  ]);
  assert.equal(child.kills, 1);
});

test('a snapshot callback after the deadline cannot authorize a late parent or descendant kill', async () => {
  for (const rows of [[root], [root, descendant]]) {
    const child = new Child();
    let elapsed = 0;
    let calls = 0;
    await assert.rejects(
      terminateWindowsBackend(child.handle(), {
        now: () => elapsed,
        budgetMs: 100,
        snapshot: async () => {
          elapsed += ++calls === 1 ? 40 : 60;
          return rows;
        },
        terminateVerified: async () => assert.fail('deadline forbids starting another helper'),
      }),
      /进程树超时/,
    );
    assert.equal(child.kills, 0);
  }
});

test('time spent building a verified target list is checked again before killing the parent handle', async () => {
  const child = new Child();
  let calls = 0;
  let elapsed = 0;
  const lateRows = new Proxy([root], {
    get(target, key, receiver) {
      if (key === 'some') elapsed = 100;
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(
    terminateWindowsBackend(child.handle(), {
      now: () => elapsed,
      budgetMs: 100,
      snapshot: async () => (++calls === 1 ? [root] : lateRows),
    }),
    /进程树超时/,
  );
  assert.equal(child.kills, 0);
});

test('process cleanup unblocks workflow shutdown before controller closes the shared database', async () => {
  const events: string[] = [];
  let finishWorkflow!: () => void;
  await closeExecutionResources({
    workspace: () => {
      events.push('stop accepting and abort workflows');
      return new Promise<void>((done) => {
        finishWorkflow = () => {
          events.push('save interrupted workflow');
          done();
        };
      });
    },
    processes: async () => {
      events.push('stop CLI processes');
      finishWorkflow();
    },
    extensions: async () => {
      events.push('stop MCP processes');
    },
    controller: async () => {
      events.push('close database');
    },
  });
  assert.equal(events[0], 'stop accepting and abort workflows');
  assert.ok(events.indexOf('stop CLI processes') < events.indexOf('save interrupted workflow'));
  assert.equal(events.at(-1), 'close database');
});

test('a failing shutdown stage still closes the other resources and is reported as incomplete', async () => {
  const events: string[] = [];
  await assert.rejects(
    closeExecutionResources({
      workspace: () => {
        throw Error('fixture workspace failure');
      },
      processes: async () => {
        events.push('processes');
      },
      extensions: async () => {
        events.push('extensions');
      },
      controller: async () => {
        events.push('controller');
      },
    }),
    AggregateError,
  );
  assert.deepEqual(events, ['processes', 'extensions', 'controller']);
});

test('live process failures remain distinguishable after all shutdown stages are attempted', async () => {
  await assert.rejects(
    closeExecutionResources({
      workspace: async () => {},
      extensions: async () => {},
      controller: async () => {},
      processes: async () => {
        throw Object.assign(new AggregateError([], 'fixture'), { code: 'owned-processes-still-running' });
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === 'owned-processes-still-running',
  );
});

// Production bounds each PowerShell/CIM helper (15 s snapshot, 8 s termination) within a 38 s shared budget. Cold
// PowerShell startup on a busy machine can exceed those, so this fixture runs the real helpers with a guard that only
// ends a genuine hang; the budget arithmetic itself is covered by the injected-clock tests above.
const HELPER_GUARD_MS = 120_000;
// CIM creation times are UTC .NET ticks (100 ns since 0001-01-01).
const dotNetTicks = (ms: number) => BigInt(ms) * 10_000n + 621_355_968_000_000_000n;

test(
  'Windows verified handles terminate a synthetic backend and grandchild while a separate fixture stays alive',
  {
    skip: process.platform !== 'win32',
    timeout: 6 * HELPER_GUARD_MS,
  },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    child.once('spawn',()=>process.send({pid:child.pid}));
    setInterval(()=>{},1000);
  `,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
    );
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let grandchild: number | undefined;
    try {
      const [message] = await once(child, 'message');
      grandchild = (message as { pid: number }).pid;
      const cleanupStarted = Date.now();
      await terminateWindowsBackend(child, {
        ...nativeOperations,
        snapshotTimeoutMs: HELPER_GUARD_MS,
        terminationTimeoutMs: HELPER_GUARD_MS,
        waitMs: HELPER_GUARD_MS,
        budgetMs: 5 * HELPER_GUARD_MS,
      });
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      let pidInUse = true;
      try {
        process.kill(grandchild, 0);
      } catch (error) {
        pidInUse = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (pidInUse) {
        // Under heavy process churn Windows can hand the stopped grandchild's PID to a new process within seconds, so
        // a live PID alone does not prove survival: only a process created before cleanup began can be the grandchild.
        const holder = (await nativeOperations.snapshot(HELPER_GUARD_MS)).find((row) => row.pid === grandchild);
        assert.ok(!holder || BigInt(holder.createdAt) > dotNetTicks(cleanupStarted), 'the grandchild must be stopped');
      }
      // Stopped: never signal this PID again, since another process may own it now.
      grandchild = undefined;
      assert.equal(unrelated.exitCode, null);
      process.kill(unrelated.pid!, 0);
    } finally {
      for (const fixture of [child, unrelated])
        if (fixture.exitCode === null && fixture.signalCode === null) {
          const finished = once(fixture, 'exit');
          fixture.kill('SIGKILL');
          await finished;
        }
      if (grandchild) {
        try {
          process.kill(grandchild, 'SIGKILL');
        } catch {
          /* Fixture already reaped. */
        }
      }
    }
  },
);
