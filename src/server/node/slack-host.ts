import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDirectory } from '../api-providers.ts';
import { SlackConfigStore, validAppToken, validBotToken } from '../slack-config.ts';
import type { SlackGateway } from '../slack-gateway.ts';
import type { SlackHostRequest } from './peer-protocol.ts';

export const slackConfigStoreFor = (role: 'desktop' | 'node') =>
  new SlackConfigStore(role === 'node' ? join(secretsDirectory(), 'slack-gateway-node.json') : undefined);

export function nodeSlackHost(deps: {
  store: SlackConfigStore;
  gateway: Pick<SlackGateway, 'saveTokens' | 'setStandby' | 'setEnabled'>;
  flagFile: string;
  desktopName: string;
}): { hostsSlack(): boolean; host(request: SlackHostRequest): Promise<{ slackHost: boolean }> } {
  const { store, gateway, flagFile, desktopName } = deps;
  let work: Promise<unknown> = Promise.resolve();
  return {
    hostsSlack() {
      try {
        return (JSON.parse(readFileSync(flagFile, 'utf8')) as { host?: unknown }).host === true;
      } catch {
        return false;
      }
    },
    host(request) {
      const next = work
        .catch(() => {})
        .then(async () => {
          if (request.host) {
            // Checked before anything is saved, so a bad token changes nothing here.
            validAppToken(request.appToken);
            validBotToken(request.botToken);
            await store.update((config) => {
              config.users = request.users;
            });
            await gateway.saveTokens({ appToken: request.appToken, botToken: request.botToken });
            writeFileSync(flagFile, JSON.stringify({ host: true }) + '\n');
            await gateway.setStandby(undefined);
            await gateway.setEnabled(true);
          } else {
            writeFileSync(flagFile, JSON.stringify({ host: false }) + '\n');
            await gateway.setStandby(desktopName);
            // Releasing hosting disables the node; its saved settings still belong to it.
            await store.update((config) => {
              config.enabled = false;
            });
          }
          return { slackHost: request.host };
        });
      work = next;
      return next;
    },
  };
}

/** First-start copy only: the shared file can belong to a running desktop and must never be changed. */
export async function migrateNodeSlackConfig(
  shared: SlackConfigStore,
  own: SlackConfigStore,
  flag: boolean,
): Promise<boolean> {
  if (!flag || (await own.exists())) return false;
  const previous = await shared.read();
  if (!previous.appToken || !previous.botToken) return false;
  return own.copyIfAbsent(previous);
}
