import { win32 as path } from 'node:path';

import { learningProviders, type LearningProvider } from '../../shared/sandbox.ts';
export { learningProviders, type LearningProvider } from '../../shared/sandbox.ts';
export function isLearningProvider(value: string): value is LearningProvider {
  return (learningProviders as readonly string[]).includes(value);
}
export function environmentValue(env: NodeJS.ProcessEnv, name: string) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
export function providerProfiles(home: string, dataDir: string, env: NodeJS.ProcessEnv) {
  const value = (name: string, fallback: string) => environmentValue(env, name) || fallback;
  return {
    pi: [value('PI_CODING_AGENT_DIR', path.join(home, '.pi', 'agent')), path.join(dataDir, 'pi', 'sessions')],
    claude: [value('CLAUDE_CONFIG_DIR', path.join(home, '.claude')), path.join(home, '.claude.json')],
    grok: [
      value('GROK_HOME', path.join(home, '.grok')),
      value('GROK_AUTH_PATH', path.join(value('GROK_HOME', path.join(home, '.grok')), 'auth.json')),
    ],
    cursor: [
      path.join(value('APPDATA', path.join(home, 'AppData', 'Roaming')), 'Cursor'),
      value('CURSOR_CONFIG_DIR', path.join(home, '.cursor')),
      path.join(home, '.cursor'),
    ],
  };
}
