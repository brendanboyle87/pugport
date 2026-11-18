import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { TestContext } from 'node:test';
import { AgentBridge } from '../../src/server/agent-bridge.ts';
import { extensions } from '../../src/server/extensions.ts';
import type { Controller } from '../../src/server/controller.ts';
import type { Workspace } from '../../src/server/workspace.ts';
import type { GitHubConnection } from '../../src/server/github.ts';

export function readBridge(
  t: TestContext,
  projectPath: string,
  github?: Pick<GitHubConnection, 'tools' | 'call' | 'defaultBranch'>,
  workspace?: Workspace,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pugport-read-bridge-'));
  t.after(() => {
    if (!dataDir.startsWith(join(tmpdir(), 'pugport-read-bridge-'))) throw new Error('Invalid cleanup path');
    rmSync(dataDir, { recursive: true, force: true });
  });
  const events: any[] = [];
  const caller = {
    run: { id: 'run', projectPath, workflowId: undefined as string | undefined },
    target: { provider: 'claude' },
    write: false,
    child: false,
    delegate: false,
    recycle: false,
    signal: new AbortController().signal,
  };
  const controller = Object.assign(new EventEmitter(), {
    dataDir,
    recordRunEvent: (_id: string, event: unknown) => events.push(event),
    agentBridgeCaller: () => caller,
    returnExecution: () => async () => {},
  }) as unknown as Controller;
  workspace ??= { store: { get: () => undefined } } as unknown as Workspace;
  t.mock.method(extensions, 'bridgeTools', () => []);
  const bridge = new AgentBridge(workspace, controller, projectPath, {}, undefined, undefined, github);
  t.after(() => bridge.close());
  const rpc = async (method: string, params?: unknown) => {
    const response = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method, params });
    return (response.body as any).result;
  };
  return {
    events,
    controller,
    caller,
    list: () => rpc('tools/list'),
    call: (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args }),
  };
}
