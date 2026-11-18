import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCodexAdapter } from '../../src/server/adapters/codex.ts';

export type CodexScript = {
  sandboxStatus?: import('../../src/shared/sandbox.ts').SandboxStatus;
  onLaunch?: (args: string[]) => void;
  failure?: unknown;
  requestFailure?: unknown;
  prefix?: Array<{ method: string; params: Record<string, unknown> }>;
  approval?: boolean;
  approvalItemId?: string;
  notificationOnly?: boolean;
  transientFailure?: unknown;
  result?: string;
  tokens?: number;
};

/** In-memory JSON-RPC peer. The real adapter runs, but there is no child process or network. */
export function syntheticCodex(script: CodexScript = {}, requests: Array<Record<string, unknown>> = []) {
  return createCodexAdapter({
    sandboxStatus: async () =>
      script.sandboxStatus ?? { available: false, reason: 'sdk-missing', message: '沙箱组件未安装' },
    targetPath: async (_target, path) => path,
    terminate: async (child) => {
      child.emit('close', 0);
    },
    spawn: async (target, args) => {
      script.onLaunch?.(args);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null,
      }) as unknown as ChildProcessWithoutNullStreams;
      const threadId = `synthetic-thread-${target.id}`,
        turnId = 'synthetic-turn';
      const send = (value: unknown) => (child.stdout as PassThrough).write(Buffer.from(JSON.stringify(value) + '\n'));
      const notify = (method: string, params: Record<string, unknown>) =>
        send({ method, params: { threadId, turnId, ...params } });
      const finish = () => {
        notify('thread/tokenUsage/updated', {
          tokenUsage: { total: { inputTokens: script.tokens ?? 7, outputTokens: 0, totalTokens: script.tokens ?? 7 } },
        });
        if (script.failure) {
          notify('error', { error: script.failure, willRetry: false });
          notify('turn/completed', {
            turn: { id: turnId, status: 'failed', ...(script.notificationOnly ? {} : { error: script.failure }) },
          });
        } else {
          notify('item/completed', {
            item: { id: 'answer', type: 'agentMessage', text: script.result ?? 'Synthetic Codex response' },
          });
          notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
        }
      };
      let buffer = '';
      child.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        let index: number;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const request = JSON.parse(raw) as Record<string, unknown>;
          requests.push(request);
          if (request.id === 'synthetic-approval') {
            finish();
            continue;
          }
          const respond = (result: unknown) => send({ id: request.id, result });
          if (request.method === 'initialize') respond({});
          else if (request.method === 'account/read')
            respond({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
          else if (request.method === 'thread/start' || request.method === 'thread/resume') {
            if (script.requestFailure) send({ id: request.id, error: script.requestFailure });
            else respond({ thread: { id: threadId } });
          } else if (request.method === 'turn/start') {
            notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
            respond({ turn: { id: turnId, status: 'inProgress' } });
            if (script.transientFailure) notify('error', { error: script.transientFailure, willRetry: true });
            for (const event of script.prefix ?? []) notify(event.method, event.params);
            if (script.approval)
              send({
                id: 'synthetic-approval',
                method: 'item/commandExecution/requestApproval',
                params: {
                  threadId,
                  turnId,
                  itemId: script.approvalItemId,
                  command: 'synthetic command',
                  reason: 'Synthetic permission request',
                },
              });
            else finish();
          } else if (request.method === 'model/list')
            respond({
              data: [{ model: 'gpt-fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
              nextCursor: null,
            });
          else if (request.method === 'account/rateLimits/read')
            respond({ rateLimits: { primary: { usedPercent: 10, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } });
          else if (request.method === 'turn/interrupt') respond({});
        }
      });
      return child;
    },
  });
}
