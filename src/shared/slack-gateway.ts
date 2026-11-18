export type SlackConnectionStatus = 'off' | 'connecting' | 'connected' | 'error';

export interface SlackPairedUser {
  isOwner?: boolean;
  id: string;
  name?: string;
  pairedAt: string;
}

/** What the page may see: token hints only, never the tokens themselves. */
export interface SlackGatewayView {
  enabled: boolean;
  status: SlackConnectionStatus;
  error?: string;
  appTokenHint?: string;
  botTokenHint?: string;
  workspace?: string;
  botName?: string;
  pairingExpiresAt?: string;
  users: SlackPairedUser[];
  activeTasks: number;
  /** Another PugPort (a device node) runs Slack, so this one does not connect. */
  hostedBy?: string;
}

export interface SlackPairingCode {
  code: string;
  expiresAt: string;
}

/**
 * Pasted into Slack's "Create New App → From an app manifest"; Socket Mode needs no public URL. The assistant
 * panel ("Agents & AI Apps") is optional because not every Slack plan offers it; @mentions and DMs work without it.
 */
export function slackAppManifest(assistant = false) {
  return {
    display_information: {
      name: 'PugPort',
      description: 'Send tasks to your PugPort desktop app; the answer comes back in the same thread.',
      background_color: '#1f1f1f',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'pugport', always_online: false },
      ...(assistant
        ? {
            assistant_view: {
              assistant_description: "Ask PugPort about the channel you're looking at.",
              suggested_prompts: [
                { title: 'Summarize', message: 'Summarize this channel' },
                { title: 'Decisions', message: 'What did we decide here?' },
              ],
            },
          }
        : {}),
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'chat:write',
          'reactions:write',
          'im:history',
          'im:read',
          'im:write',
          'channels:history',
          'groups:history',
          'mpim:history',
          'users:read',
          ...(assistant ? ['assistant:write'] : []),
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          'app_mention',
          'message.im',
          'message.channels',
          'message.groups',
          ...(assistant ? ['assistant_thread_started', 'assistant_thread_context_changed'] : []),
        ],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
