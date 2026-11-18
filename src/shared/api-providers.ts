/**
 * API platforms a user can add with their own key. Each runs through the built-in model runtime with only
 * that platform's models; the key never enters the data folder. `balance` names a documented, free balance
 * endpoint; other platforms link to their billing console instead.
 */
export type ApiPreset = {
  id: string;
  label: string;
  /** The runtime's provider id for this platform's built-in model catalog (with prices). */
  runtimeProvider: string;
  /** The environment variable the runtime reads this platform's key from. */
  keyVariable: string;
  console: string;
  keyPage: string;
  tier?: 'free';
  local?: boolean;
  mayLog?: boolean;
  keyless?: boolean;
  endpoint?: {
    baseUrl: string;
    api: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
    discovery:
      'ollama-tags' | 'openai-models' | 'openrouter-free' | 'gemini' | 'github' | 'anthropic' | 'xai' | 'openrouter';
  };
  termsUrl?: string;
  balance?: 'deepseek' | 'openrouter' | 'moonshot' | 'moonshot-cn';
  /** The currency the platform bills in; costs are shown in it by default. */
  currency?: 'CNY' | 'USD';
  /** The platform's image API, used only for image generation; its models stay out of the chat catalog. */
  images?: 'openai-images';
};

export const apiProtocols = [
  'azure-openai-responses',
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
] as const;
export type ApiConnection = {
  protocol: (typeof apiProtocols)[number];
  baseUrl: string;
  model: string;
  /** User-supplied USD estimates per million tokens, not a platform invoice. */
  price?: { input: number; output: number };
  /** Token limits reported to Pi. Applied on macOS only (server/platform/api-limits.ts); elsewhere they are kept but unused. */
  limits?: { contextWindow?: number; maxTokens?: number };
};

/** The fixed limits of a custom connection without its own, and the range a configured limit may take. */
export const apiLimitDefaults = { contextWindow: 32768, maxTokens: 4096 } as const;
export const apiLimitRange = { min: 1024, max: 2_097_152 } as const;

/** Shared by the form and server. Never persist credentials or request parameters in an endpoint. */
export function validateApiConnection(value: unknown): ApiConnection {
  const connection = value as Partial<ApiConnection> | undefined;
  if (!connection || !apiProtocols.includes(connection.protocol!)) throw new Error('请选择支持的 API 协议。');
  if (
    typeof connection.baseUrl !== 'string' ||
    !/^https?:\/\//i.test(connection.baseUrl.trim()) ||
    /[\\\s]/.test(connection.baseUrl.trim())
  )
    throw new Error('请输入有效的 API 地址。');
  const base = validateFreeBaseUrl(connection.baseUrl);
  const url = new URL(base);
  if (
    !url.hostname ||
    (!url.hostname.startsWith('[') &&
      !url.hostname.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part)))
  )
    throw new Error('请输入有效的 API 主机名。');
  const suffixes = {
    'azure-openai-responses': '/responses',
    'openai-responses': '/responses',
    'openai-completions': '/chat/completions',
    'anthropic-messages': '/messages',
  };
  let path = url.pathname.replace(/\/+$/, '');
  const suffix = suffixes[connection.protocol!];
  const methods = ['/responses', '/chat/completions', '/messages'];
  if (methods.some((method) => path.endsWith(method) && method !== suffix))
    throw new Error('API 地址的方法与所选协议不匹配。');
  if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  if (connection.protocol === 'azure-openai-responses') {
    if (!path || path === '/openai') path = '/openai/v1';
    if (path !== '/openai/v1') throw new Error('Azure 地址须为资源根地址或 /openai/v1。');
  }
  if (
    typeof connection.model !== 'string' ||
    connection.model.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(connection.model)
  )
    throw new Error('请输入有效的模型或部署 ID。');
  let price: ApiConnection['price'];
  if (connection.price !== undefined) {
    if (
      !connection.price ||
      ![connection.price.input, connection.price.output].every(
        (amount) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0,
      ) ||
      !Number.isFinite(connection.price.input * 2)
    )
      throw new Error('输入和输出价格须为正数。');
    price = { input: connection.price.input, output: connection.price.output };
  }
  let limits: ApiConnection['limits'];
  if (connection.limits !== undefined) {
    const { contextWindow, maxTokens } = connection.limits ?? {};
    const valid = (amount: unknown) =>
      amount === undefined ||
      (typeof amount === 'number' &&
        Number.isInteger(amount) &&
        amount >= apiLimitRange.min &&
        amount <= apiLimitRange.max);
    if (!connection.limits || !valid(contextWindow) || !valid(maxTokens))
      throw new Error('上下文和输出上限须为 1,024 到 2,097,152 之间的整数。');
    if ((maxTokens ?? apiLimitDefaults.maxTokens) > (contextWindow ?? apiLimitDefaults.contextWindow))
      throw new Error('输出上限不能超过上下文长度。');
    if (contextWindow !== undefined || maxTokens !== undefined)
      limits = {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
  }
  return {
    protocol: connection.protocol!,
    baseUrl: `${url.origin}${path}`,
    model: connection.model,
    ...(price ? { price } : {}),
    ...(limits ? { limits } : {}),
  };
}

export const metaModelIds = ['muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'];

export const apiPresets: ApiPreset[] = [
  {
    id: 'deepseek',
    currency: 'CNY',
    label: 'DeepSeek',
    runtimeProvider: 'deepseek',
    keyVariable: 'DEEPSEEK_API_KEY',
    console: 'https://platform.deepseek.com/usage',
    keyPage: 'https://platform.deepseek.com/api_keys',
    balance: 'deepseek',
    // https://api-docs.deepseek.com/api/list-models - Bearer; data[].id (metadata, no inference).
    endpoint: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', discovery: 'openai-models' },
  },
  {
    id: 'meta-model-api',
    label: 'Meta Model API',
    runtimeProvider: 'pugport-meta',
    keyVariable: 'MODEL_API_KEY',
    console: 'https://dev.meta.ai/',
    keyPage: 'https://dev.meta.ai/',
    endpoint: { baseUrl: 'https://api.meta.ai/v1', api: 'openai-completions', discovery: 'openai-models' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    runtimeProvider: 'openai',
    keyVariable: 'OPENAI_API_KEY',
    // https://developers.openai.com/api/reference/resources/models/methods/list - Bearer; data[].id.
    endpoint: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', discovery: 'openai-models' },
    // https://platform.openai.com/docs/api-reference/images - generations (JSON) and edits (multipart), b64_json.
    images: 'openai-images',
    console: 'https://platform.openai.com/usage',
    keyPage: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    runtimeProvider: 'anthropic',
    keyVariable: 'ANTHROPIC_API_KEY',
    // https://platform.claude.com/docs/en/api/models/list - x-api-key + anthropic-version; data[], has_more.
    endpoint: { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', discovery: 'anthropic' },
    console: 'https://console.anthropic.com/settings/billing',
    keyPage: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'xai',
    label: 'xAI',
    runtimeProvider: 'xai',
    keyVariable: 'XAI_API_KEY',
    // https://docs.x.ai/developers/rest-api-reference/inference/models - Bearer; language-models excludes media.
    endpoint: { baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', discovery: 'xai' },
    console: 'https://console.x.ai',
    keyPage: 'https://console.x.ai',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    runtimeProvider: 'google',
    keyVariable: 'GEMINI_API_KEY',
    // https://ai.google.dev/api/models#method:-models.list - x-goog-api-key; models[], nextPageToken, generateContent.
    endpoint: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      api: 'google-generative-ai',
      discovery: 'gemini',
    },
    console: 'https://aistudio.google.com/usage',
    keyPage: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    runtimeProvider: 'openrouter',
    keyVariable: 'OPENROUTER_API_KEY',
    console: 'https://openrouter.ai/settings/credits',
    keyPage: 'https://openrouter.ai/settings/keys',
    balance: 'openrouter',
    // https://openrouter.ai/docs/api/api-reference/models/get-models - Bearer; data[].architecture.output_modalities.
    endpoint: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', discovery: 'openrouter' },
  },
  {
    id: 'moonshot-cn',
    currency: 'CNY',
    label: 'Kimi（月之暗面）',
    runtimeProvider: 'moonshotai-cn',
    keyVariable: 'MOONSHOT_API_KEY',
    console: 'https://platform.moonshot.cn/console/account',
    keyPage: 'https://platform.moonshot.cn/console/api-keys',
    balance: 'moonshot-cn',
    // https://platform.moonshot.cn/docs/api/list-models - Bearer; data[].id, chat models only.
    endpoint: { baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions', discovery: 'openai-models' },
  },
  {
    id: 'moonshot',
    label: 'Kimi（国际）',
    runtimeProvider: 'moonshotai',
    keyVariable: 'MOONSHOT_API_KEY',
    console: 'https://platform.moonshot.ai/console/account',
    keyPage: 'https://platform.moonshot.ai/console/api-keys',
    balance: 'moonshot',
    // https://platform.kimi.ai/docs/api/list-models - Bearer; data[].id, chat models only.
    endpoint: { baseUrl: 'https://api.moonshot.ai/v1', api: 'openai-completions', discovery: 'openai-models' },
  },
  {
    id: 'zai-cn',
    currency: 'CNY',
    label: '智谱 GLM',
    runtimeProvider: 'zai-coding-cn',
    keyVariable: 'ZAI_CODING_CN_API_KEY',
    console: 'https://bigmodel.cn/finance-center/finance/overview',
    keyPage: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'qwen-cn',
    currency: 'CNY',
    label: '通义千问',
    runtimeProvider: 'qwen-token-plan-cn',
    keyVariable: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    console: 'https://bailian.console.aliyun.com',
    keyPage: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'minimax-cn',
    currency: 'CNY',
    label: 'MiniMax',
    runtimeProvider: 'minimax-cn',
    keyVariable: 'MINIMAX_CN_API_KEY',
    console: 'https://platform.minimaxi.com/user-center/payment/balance',
    keyPage: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    runtimeProvider: 'mistral',
    keyVariable: 'MISTRAL_API_KEY',
    console: 'https://console.mistral.ai/usage',
    keyPage: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'custom-api',
    label: '自定义 API',
    runtimeProvider: 'pugport-custom-api',
    keyVariable: 'PUGPORT_API_KEY',
    console: '',
    keyPage: '',
  },
];

export const freePresets: ApiPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    runtimeProvider: 'pugport-ollama',
    local: true,
    keyless: true,
    url: 'http://127.0.0.1:11434/v1',
    discovery: 'ollama-tags',
    terms: 'https://ollama.com/terms',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    runtimeProvider: 'pugport-lmstudio',
    local: true,
    keyless: true,
    url: 'http://127.0.0.1:1234/v1',
    discovery: 'openai-models',
    terms: 'https://lmstudio.ai/terms',
  },
  {
    id: 'openrouter-free',
    label: 'OpenRouter',
    runtimeProvider: 'pugport-openrouter-free',
    url: 'https://openrouter.ai/api/v1',
    discovery: 'openrouter-free',
    terms: 'https://openrouter.ai/terms-of-service',
    keys: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'gemini-free',
    label: 'Gemini',
    runtimeProvider: 'pugport-gemini-free',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    discovery: 'gemini',
    terms: 'https://ai.google.dev/gemini-api/terms',
    keys: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq-free',
    label: 'Groq',
    runtimeProvider: 'pugport-groq',
    url: 'https://api.groq.com/openai/v1',
    discovery: 'openai-models',
    terms: 'https://console.groq.com/docs/legal/terms-of-use',
    keys: 'https://console.groq.com/keys',
  },
  {
    id: 'github-models',
    label: 'GitHub Models',
    runtimeProvider: 'pugport-github-models',
    url: 'https://models.github.ai/inference',
    discovery: 'github',
    terms: 'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features',
    keys: 'https://github.com/settings/tokens',
  },
  {
    id: 'custom',
    label: '自定义地址',
    runtimeProvider: 'pugport-custom',
    keyless: true,
    url: '',
    discovery: 'openai-models',
    terms: '',
  },
].map((source) => ({
  id: source.id,
  label: source.label,
  runtimeProvider: source.runtimeProvider,
  tier: 'free',
  local: source.local === true,
  mayLog: source.local !== true,
  keyless: source.keyless === true,
  keyVariable: 'PUGPORT_SOURCE_KEY',
  endpoint: {
    baseUrl: source.url,
    api: 'openai-completions',
    discovery: source.discovery as NonNullable<ApiPreset['endpoint']>['discovery'],
  },
  termsUrl: source.terms,
  console: source.keys ?? '',
  keyPage: source.keys ?? '',
}));

export const isFreePreset = (id: string | undefined) => freePresets.some((preset) => preset.id === id);

/** Shared by the form and server; credentials never belong in a persisted URL. */
export function validateFreeBaseUrl(value: string): string {
  const clean = value.trim();
  if (!clean || value.length > 2000) throw new Error('地址须为不超过 2000 字的有效网址。');
  let url: URL;
  try {
    url = new URL(clean);
  } catch {
    throw new Error('请输入有效的网址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('地址仅支持 http 或 https，不能包含账号、密码、查询参数或片段。');
  const normalized = url.toString().replace(/\/+$/, '');
  if (normalized.length > 2000) throw new Error('地址须为不超过 2000 字的有效网址。');
  return normalized;
}

export const apiPreset = (id: string | undefined) => [...apiPresets, ...freePresets].find((preset) => preset.id === id);

/** One API platform as the executors page shows it. The key itself never leaves the server. */
export type ApiProviderView = {
  unavailable?: string;
  connection?: ApiConnection;
  connectionError?: string;
  tier?: 'free';
  local?: boolean;
  mayLog?: boolean;
  baseUrl?: string;
  detected?: boolean;
  modelCount?: number;
  cooldown?: import('./accounts.ts').AccountAvailability;
  targetId: string;
  preset: string;
  label: string;
  enabled: boolean;
  keyHint?: string;
  console: string;
  balance?: ApiBalance;
  currency: 'CNY' | 'USD';
  /** Calls made outside tasks, such as tidying voice input. */
  extra?: { calls: number; tokens: number; costUsd: number };
  budget?: ApiBudgetView;
  /** Anthropic: the workspace sent with each request, when the key is not scoped to one. */
  workspaceId?: string;
  /** Anthropic: why the workspace could not be filled in automatically. */
  workspaceLookup?: WorkspaceLookupFailure;
};

export type WorkspaceLookupFailure = {
  at: string;
  outcome: 'refused' | 'several' | 'none' | 'network';
  /** The platform's HTTP status when it refused. */
  status?: number;
  /** How many workspaces there were when none could be picked. */
  count?: number;
};

/** Anthropic workspace IDs look like wrkspc_…; anything else is rejected before it reaches a header. */
export const validWorkspaceId = (value: string) => /^[A-Za-z0-9_-]{1,100}$/.test(value);

/** A local USD spending estimate, independent of the platform's actual balance/invoice. */
export type ApiBudgetPolicy = {
  limitUsd?: number;
  expiresAt?: string;
  perRunUsd: number;
  maxConcurrentRuns: number;
  burstConcurrentRuns: number;
  preferExpiring: boolean;
  /** Recurring monthly credit (e.g. ChatGPT Pro's API grant): at expiresAt the balance becomes this, unused credit lapses. */
  monthlyUsd?: number;
  /** The subscription account that earns the monthly credit; the credit lasts only while it reports a paid plan. */
  linkedAccountId?: string;
  startedAt: string;
};
export type ApiBudgetInput = Partial<Omit<ApiBudgetPolicy, 'startedAt'>> & { reset?: boolean };
export type ApiBudgetView = {
  policy: ApiBudgetPolicy;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd?: number;
  unreportedRuns: number;
  phase: 'normal' | 'priority' | 'accelerated' | 'sprint' | 'expired' | 'exhausted';
  maxConcurrentRuns: number;
  daysRemaining?: number;
};

/** A one-time credit that has expired or run out has nothing left to show; a monthly one comes back next month. */
export function apiCreditGone(view: Pick<ApiBudgetView, 'policy' | 'phase'> | undefined, now: number): boolean {
  return (
    !!view &&
    !view.policy.monthlyUsd &&
    (view.phase === 'expired' || view.phase === 'exhausted' || Date.parse(view.policy.expiresAt ?? '') <= now)
  );
}

/** Linear credit pacing uses the recorded period, never extrapolated burn rate. */
export function apiCreditPace(view: ApiBudgetView | undefined, now: number) {
  if (!view) return;
  const { limitUsd, startedAt, expiresAt, preferExpiring, perRunUsd, monthlyUsd } = view.policy;
  // A monthly credit spreads over its whole period; a one-off expiring credit only over its last fourteen days.
  const start = monthlyUsd
    ? Date.parse(startedAt)
    : Math.max(Date.parse(startedAt), Date.parse(expiresAt ?? '') - 14 * 86_400_000);
  const end = Date.parse(expiresAt ?? '');
  if (
    !limitUsd ||
    !Number.isFinite(limitUsd) ||
    limitUsd <= 0 ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(now) ||
    !Number.isFinite(view.spentUsd) ||
    view.spentUsd < 0 ||
    !Number.isFinite(view.reservedUsd) ||
    view.reservedUsd < 0 ||
    !Number.isFinite(perRunUsd) ||
    perRunUsd <= 0
  )
    return;
  const plannedUsd = limitUsd * Math.max(0, Math.min(1, (now - start) / (end - start)));
  const behindUsd = plannedUsd - view.spentUsd;
  const remaining = Math.min(view.remainingUsd ?? Infinity, limitUsd - view.spentUsd - view.reservedUsd);
  const priority =
    preferExpiring &&
    now >= start &&
    now < end &&
    behindUsd > 1e-9 &&
    view.phase !== 'expired' &&
    view.phase !== 'exhausted' &&
    remaining + 1e-9 >= perRunUsd
      ? behindUsd / limitUsd
      : 0;
  return { plannedUsd, priority };
}

/** For showing USD-priced estimates in yuan and back; an approximation, labelled as such where shown. */
export const USD_TO_CNY = 7.1;

export type ApiBalance = {
  observedAt: string;
  /** One entry per currency; amounts are what the platform reported. */
  amounts?: Array<{ currency: string; total: number }>;
  error?: string;
};

/** Route-policy key: CLI platforms by provider, API platforms by preset. */
export const routeKey = (snapshot: { provider: string; apiProvider?: string }) =>
  snapshot.apiProvider ? `api:${snapshot.apiProvider}` : snapshot.provider;

const cliNames: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
  gemini: 'Gemini',
};
export const routeKeyLabel = (key: string) =>
  key.startsWith('api:')
    ? `${apiPreset(key.slice(4))?.label ?? key.slice(4)}${isFreePreset(key.slice(4)) || apiPreset(key.slice(4))?.label.endsWith(' API') ? '' : ' API'}`
    : (cliNames[key] ?? key);
