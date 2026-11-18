import { SlackConnectionLock } from '../../src/server/slack-connection-lock.ts';

const lock = new SlackConnectionLock({ directory: process.argv[2]!, role: 'node' });
process.on('message', async (message) => {
  if (message === 'release') {
    lock.release();
    process.disconnect!();
  } else if (typeof message === 'number') {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, message - Date.now())));
    process.send!(await lock.acquire('A0SYNTH', () => {}));
  }
});
process.send!('ready');
