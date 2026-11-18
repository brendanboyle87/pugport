import type { Provider } from './types.ts';

/**
 * One entry per executor kind. Everything the rest of PugPort needs to know about a provider as a
 * *kind* lives here, so a new executor is a new row (the compiler insists on one for every Provider)
 * plus an adapter, instead of a hunt through `provider === '…'` checks.
 *
 * Only policy belongs here: what a provider can do and how it is told apart. How a given CLI is
 * launched, parsed or fingerprinted stays with its adapter.
 */
export type ProviderSpec = {
  /** `cli`: a native CLI on this machine with its own login and quota. `api`: PugPort's own harness over an API key. */
  transport: 'cli' | 'api';
  /** Removed from the core build: existing configuration, sessions and usage stay; nothing new runs on it. */
  retired?: true;
  /**
   * How a native account is told apart.
   * `home`: an isolated config directory per account, so the default target is an account by itself.
   * `login`: the CLI's own login profile, so a second account needs an explicit accountId.
   */
  accountIdentity?: 'home' | 'login';
  /**
   * Where the CLI keeps its login and settings. `env` points the CLI at an isolated copy; `name` is the
   * directory under the user's home. With `envIsParent`, `env` names the parent directory instead.
   */
  configDir?: { env: string; name: string; envIsParent?: true };
  /** Quota, health and account identity are tracked only under this authentication mode. */
  quotaAuthMode?: 'chatgpt';
  /** The CLI's own sign-in command. */
  loginArgs?: readonly string[];
  /** The default native target's command can be found automatically. */
  commandAutoDiscovery?: true;
  /** Accepts images in prompts without PugPort describing them first. */
  nativeVision?: true;
  /**
   * Can make images when the owner asks for one in chat.
   * `native-tool`: the CLI's own image tool, on the account's subscription (no per-image charge).
   * `api-images`: an API card whose platform offers an image model (ApiPreset.images); charged per image.
   */
  imageGeneration?: 'native-tool' | 'api-images';
  /** A steer message interrupts the running turn instead of waiting for it. */
  steerInterrupts?: true;
  /** Runs commands automatically, as device write tasks need. */
  runsCommands?: true;
  /** Cursor offers this maker's model family too, so a quota stop can continue there on the same family. */
  modelsOnCursor?: true;
  /** How long one PugPort tool call may hold the executor's turn, and the margin kept to restore it. */
  bridge: { callSeconds: number; restoreMarginMs: number };
};

const defaultBridge = { callSeconds: 240, restoreMarginMs: 10_000 } as const;

export const providerSpecs: Readonly<Record<Provider, ProviderSpec>> = {
  codex: {
    transport: 'cli',
    accountIdentity: 'home',
    configDir: { env: 'CODEX_HOME', name: '.codex' },
    quotaAuthMode: 'chatgpt',
    loginArgs: ['login', '--device-auth'],
    commandAutoDiscovery: true,
    nativeVision: true,
    // Codex CLI's built-in image_generation tool (features list: stable). Its app-server reports each image as an
    // imageGeneration thread item with the PNG bytes (result) and the copy it saved under CODEX_HOME/generated_images.
    imageGeneration: 'native-tool',
    runsCommands: true,
    modelsOnCursor: true,
    bridge: defaultBridge,
  },
  claude: {
    transport: 'cli',
    accountIdentity: 'login',
    configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
    // The subscription login, never Console API billing.
    loginArgs: ['auth', 'login', '--claudeai'],
    commandAutoDiscovery: true,
    nativeVision: true,
    steerInterrupts: true,
    runsCommands: true,
    modelsOnCursor: true,
    bridge: defaultBridge,
  },
  grok: {
    transport: 'cli',
    accountIdentity: 'home',
    loginArgs: ['login', '--device-auth'],
    // No imageGeneration: the CLI help documents no image option and its ACP stream defines no image result. The
    // binary mentions an interactive `/imagine` command behind a feature flag, which PugPort cannot drive or collect.
    steerInterrupts: true,
    runsCommands: true,
    modelsOnCursor: true,
    // Grok's agent loop gives a tool call less time than the others.
    bridge: { callSeconds: 50, restoreMarginMs: 5000 },
  },
  cursor: {
    transport: 'cli',
    accountIdentity: 'login',
    loginArgs: ['login'],
    commandAutoDiscovery: true,
    runsCommands: true,
    bridge: defaultBridge,
  },
  gemini: {
    transport: 'cli',
    retired: true,
    bridge: defaultBridge,
  },
  pi: {
    transport: 'api',
    // Only cards whose platform offers images (ApiPreset.images) and lists an image model qualify.
    imageGeneration: 'api-images',
    bridge: defaultBridge,
  },
  dsh: {
    transport: 'api',
    retired: true,
    bridge: defaultBridge,
  },
};

/** Every provider, in catalogue order. */
export const providerIds = Object.keys(providerSpecs) as [Provider, ...Provider[]];
/** Providers that can still run new tasks. */
export const activeProviders = providerIds.filter((id) => !providerSpecs[id].retired) as [Provider, ...Provider[]];
/** Native CLIs with their own login and quota. */
export const nativeCliProviders = activeProviders.filter((id) => providerSpecs[id].transport === 'cli') as [
  Provider,
  ...Provider[],
];

export const providerSpec = (provider: Provider | string): ProviderSpec | undefined =>
  providerSpecs[provider as Provider];
export const isNativeCli = (provider: Provider | string | undefined): boolean =>
  !!provider && !providerSpec(provider)?.retired && providerSpec(provider)?.transport === 'cli';
export const isApiHarness = (provider: Provider | string | undefined): boolean =>
  !!provider && providerSpec(provider)?.transport === 'api';
export const isRetiredProvider = (provider: Provider | string | undefined): boolean =>
  !!provider && providerSpec(provider)?.retired === true;
/** Whether quota and identity observed under this authentication mode count for the provider. */
export const quotaAuthAccepted = (provider: Provider | string, authMode: string | undefined): boolean => {
  const required = providerSpec(provider)?.quotaAuthMode;
  return !required || authMode === required;
};
/** Providers that take images in prompts natively. */
export const nativeVisionProviders = providerIds.filter((id) => providerSpecs[id].nativeVision);
/** How a provider makes images, if it can; routing reads only this, so a new provider joins by declaring it. */
export const imageGenerationKind = (provider: Provider | string | undefined): ProviderSpec['imageGeneration'] =>
  provider && !providerSpec(provider)?.retired ? providerSpec(provider)?.imageGeneration : undefined;
/** How long one PugPort tool call may hold this provider's turn. */
export const bridgeTiming = (provider: Provider | string): ProviderSpec['bridge'] =>
  providerSpec(provider)?.bridge ?? defaultBridge;
