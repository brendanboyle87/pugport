export type WebSearchView = {
  provider: 'deepseek';
  enabled: boolean;
  configured: boolean;
  keyHint?: string;
  monthlyLimitCny: number;
  month: string;
  usage: {
    requests: number;
    billableRequests: number;
    uncertainRequests: number;
    estimatedCostCny: number;
    reservedCny: number;
  };
};

export type WebSearchUpdate = { key?: string; clearKey?: boolean; enabled?: boolean; monthlyLimitCny?: number };
export type WebSearchInput = { query: string; englishQuery?: string; count?: number };
export type WebSearchOrigin = 'query' | 'englishQuery';
export type WebSearchResult = {
  title: string;
  url: string;
  summary: string;
  date?: string;
  origins?: WebSearchOrigin[];
};
export type WebSearchReceipt = { requestId: string; durationMs: number; estimatedCostCny: number; truncated: boolean };
export type WebSearchResponse = WebSearchReceipt & {
  query: string;
  results: WebSearchResult[];
  searches?: Array<
    { query: string; origin: WebSearchOrigin } & (WebSearchReceipt | { error: string; estimatedCostCny: null })
  >;
  note?: string;
};
export type WebFetchResponse = WebSearchReceipt & { url: string; title: string; content: string };

/** A query-bearing slash command is a direct search, without a model-selection round. */
export function webSearchCommand(content: string): { query: string } | undefined {
  const match = /^\/(?:搜索|search)(?:\s+([\s\S]*))?$/i.exec(content.trim());
  return match ? { query: match[1]?.trim() ?? '' } : undefined;
}

export function webSearchAllowed(request: string): boolean {
  return !/不(?:能|可)?(?:联网|上网|搜索|检索|浏览)|(?:不要|禁止|无需|不用|不许|别|不需要|不允许)[^\n。！？]{0,12}(?:联网|上网|搜索|检索|浏览)|\b(?:do\s+not|don't|never|without|no)\b[^\n.!?]{0,32}\b(?:search(?:ing)?|brows(?:e|ing)|internet|online|network|web)\b|\b(?:offline|local[- ]only)\b|(?:仅|只)(?:用|使用|查|分析|检查|读取|读)?本地/i.test(
    request,
  );
}
