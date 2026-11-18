// Synthetic IPC peer: never loads native code or executor accounts.
// Bound even a deliberately silent peer if its test is cancelled before protocol startup.
setTimeout(() => process.exit(24), 30000).unref();
const mode = process.argv[2];
const reply = (message) => new Promise((resolve) => process.send(message, () => resolve()));
process.on('message', async (request) => {
  if (request.type === 'probe') {
    if (mode === 'crash') return process.exit(23);
    await reply({
      type: 'probe',
      result: { sdkVersion: '1.0.1', tier: 'base-container', probes: { baseContainerSupportsDenyPaths: true } },
    });
    process.disconnect();
    return;
  }
  if (request.type === 'kill') {
    process.stdin.destroy();
    process.disconnect();
    return;
  }
  if (mode === 'hang') return;
  if (mode === 'crash') return process.exit(23);
  await reply({ type: 'ready', pid: process.pid });
  if (mode === 'crash-running') return setTimeout(() => process.exit(23), 10);
  process.stdin.on('data', (chunk) => process.stdout.write(chunk));
  process.stdin.on('end', async () => {
    process.stderr.write('synthetic stderr');
    await reply({ type: 'done', exitCode: 7, timedOut: false });
    process.disconnect();
  });
});
