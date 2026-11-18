import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCodexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext, RunEvent, RuntimeTarget } from '../src/shared/types.ts';

const accountId = 'synthetic-post-turn-account';
const accountFingerprint = createHash('sha256')
  .update(JSON.stringify(['codex', 'account_id', accountId]))
  .digest('hex');
const target: RuntimeTarget = {
  id: 'codex-native',
  provider: 'codex',
  label: 'Synthetic',
  enabled: true,
  environment: 'native',
  command: 'never-spawn',
  accountFingerprint,
};

for (const mode of [
  'valid',
  'wrong-account',
  'missing-account',
  'empty-bucket',
  'malformed-window',
  'usage-disabled',
  'spend-control',
  'timeout',
  'cancel',
] as const)
  test(`Codex bounded post-turn quota: ${mode}`, async () => {
    const abort = new AbortController();
    const events: RunEvent[] = [];
    const requests: string[] = [];
    let completed = false;
    let toolsEnded = false;
    let finishing = false;
    let terminated = false;
    let quotaRequested = 0;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams;
    const send = (packet: unknown) => (child.stdout as PassThrough).write(JSON.stringify(packet) + '\n');
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += String(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const packet = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(packet.method);
        const respond = (result: unknown) => send({ id: packet.id, result });
        if (packet.method === 'initialize') respond({});
        if (packet.method === 'thread/start') respond({ thread: { id: 'thread' } });
        if (packet.method === 'turn/start') {
          respond({ turn: { id: 'turn' } });
          send({
            method: 'item/completed',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              item: { id: 'text', type: 'agentMessage', text: 'Synthetic reply' },
            },
          });
          completed = true;
          send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
        }
        if (packet.method === 'account/rateLimits/read') {
          assert.equal(completed, true, 'quota query starts only after the final native turn');
          assert.equal(terminated, false, 'the existing authenticated connection remains open');
          assert.equal(toolsEnded && finishing, true, 'tools and steering close before metadata is requested');
          quotaRequested++;
          if (mode === 'timeout') continue;
          if (mode === 'cancel') {
            abort.abort();
            continue;
          }
          respond({
            ordinaryUsageAllowed: mode !== 'usage-disabled',
            ...(mode !== 'missing-account' ? { accountId: mode === 'wrong-account' ? 'other' : accountId } : {}),
            ...(mode === 'empty-bucket'
              ? {
                  rateLimitsByLimitId: {
                    old: { primary: { usedPercent: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
                    new: {},
                  },
                }
              : {
                  rateLimits: {
                    spendControlReached: mode === 'spend-control',
                    primary: {
                      usedPercent: mode === 'malformed-window' ? -20 : 95,
                      resetsAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                    secondary: null,
                  },
                }),
          });
        }
        if (packet.method === 'turn/interrupt') respond({});
      }
    });
    const adapter = createCodexAdapter({
      spawn: async () => child,
      targetPath: async (_target, path) => path,
      sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: 'Synthetic' }),
      terminate: async () => {
        terminated = true;
        child.emit('close', 0);
      },
    });
    const context: ExecuteContext = {
      target,
      input: { prompt: 'Synthetic request', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
      route: {
        runtimeId: target.id,
        model: 'fixture',
        effort: 'low',
        kind: 'general',
        reasons: [],
        warnings: [],
        accountFingerprint,
      },
      signal: abort.signal,
      emit: (event) => events.push(event),
      approve: async () => false,
      endTools: () => {
        toolsEnded = true;
      },
      registerSteer: (_handler, status) => {
        finishing = status?.state === 'finishing';
      },
    };
    const started = Date.now();
    if (mode === 'cancel') await assert.rejects(adapter.execute(context), /cancel/i);
    else {
      const result = await adapter.execute(context);
      assert.equal(result.output, 'Synthetic reply');
      if (mode === 'valid') {
        assert.equal(result.postTurnQuota?.accountFingerprint, accountFingerprint);
        assert.equal(result.postTurnQuota?.quota.windows[0]?.usedPercent, 95);
        assert.equal(result.postTurnQuota?.complete, true);
      } else assert.equal(result.postTurnQuota, undefined);
    }
    assert.equal(quotaRequested, 1);
    assert.equal(terminated, true, 'all success/failure/cancellation paths close the native process');
    assert.equal(requests.includes('model/list'), false);
    assert.equal(events.filter((event) => event.data?.kind === 'post-turn-quota-read').length, 1);
    if (mode === 'timeout') {
      assert.ok(Date.now() - started >= 900, 'the metadata query gets its bounded response window');
      assert.ok(Date.now() - started < 5000, 'the default twenty-second RPC timeout is not used');
    }
  });
