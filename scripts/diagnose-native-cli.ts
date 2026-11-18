import { writeFile } from 'node:fs/promises';
import { defaultTargets } from '../src/server/discovery.js';
import { claudeAdapter } from '../src/server/adapters/claude.js';
import { grokAdapter } from '../src/server/adapters/grok.js';
import { captureTarget, redactError, shutdownOwnedProcesses } from '../src/server/adapters/process.js';

// Never print raw status output: native status may include account identifiers.
const result: Record<string, unknown> = { capturedAt: new Date().toISOString() };
try {
  for (const target of defaultTargets().filter((t) => t.provider === 'claude' || t.provider === 'grok')) {
    const snapshot = await (target.provider === 'claude' ? claudeAdapter : grokAdapter).discover(target);
    const item: Record<string, unknown> = { command: target.command, snapshot };
    if (target.provider === 'claude') {
      try {
        const response = await captureTarget(target, ['auth', 'status'], {
          timeoutMs: 15000,
          acceptedExitCodes: [0, 1],
        });
        const status = JSON.parse(response.stdout);
        item.authentication = {
          loggedIn: status.loggedIn === true,
          authMethod:
            typeof status.authMethod === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(status.authMethod)
              ? status.authMethod
              : 'unknown',
          apiProvider:
            typeof status.apiProvider === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(status.apiProvider)
              ? status.apiProvider
              : 'unknown',
        };
      } catch (error) {
        item.authStatusError = redactError(error);
      }
    }
    result[target.provider] = item;
  }
  await writeFile('reports/native-cli-diagnostics.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await shutdownOwnedProcesses();
}
