import { waitForBackendContainment, waitForPosixContainment } from './backend-bootstrap.ts';

try {
  if (process.env.PUGPORT_BACKEND_GUARD === 'windows-job') await waitForBackendContainment(process);
  if (process.env.PUGPORT_BACKEND_GUARD === 'posix-groups') await waitForPosixContainment(process);
  // External to this bundle: importing main before the containment gate would
  // construct the workspace and its children before the job can protect them.
  await import('./main.js');
} catch (error) {
  process.send?.({ type: 'fatal', error: error instanceof Error ? error.message : 'backend-containment-failed' });
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
}
