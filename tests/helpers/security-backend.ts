// Real HTTP/IPC boundary with synthetic learning observations and no executor or MCP launches.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Controller } from '../../src/server/controller.ts';
import { ExtensionHub } from '../../src/server/extensions.ts';
import { LearningStore } from '../../src/server/sandbox/learning-store.ts';
import { parseLearningReport } from '../../src/server/sandbox/learning-report.ts';

if (process.env.PUGPORT_TEST_CALLER_PROBE === '1') {
  const original = childProcess.execFile;
  (childProcess as any).execFile = (file: string, ...args: any[]) => {
    if (/netstat\.exe$|powershell\.exe$/.test(file)) {
      if (file.endsWith('netstat.exe')) process.send?.({ type: 'caller-probe' });
      setImmediate(() => args.at(-1)(new Error('synthetic probe failure'), '', ''));
      return {};
    }
    return (original as any)(file, ...args);
  };
  syncBuiltinESMExports();
}
Controller.prototype.refresh = async () => {};
ExtensionHub.prototype.check = async () => [];
const selection = LearningStore.prototype.selection;
LearningStore.prototype.selection = function (provider, ids) {
  this.record({
    provider: 'pi',
    observedAt: 'synthetic',
    groups: [],
    ...parseLearningReport({
      denials: [{ resource: 'C:/synthetic/allowed.txt', resourceType: 'file', accessType: 'read' }],
    }),
  });
  return selection.call(this, provider, ids);
};
await import('../../src/server/main.ts');
