import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WebSearchInput,
  WebSearchResponse,
  WebSearchUpdate,
  WebSearchView,
  WebFetchResponse,
  WebSearchOrigin,
} from '../shared/web-search.ts';
import { secretsDirectory } from './api-providers.ts';
import { isolatedUserPath } from './platform/under-test.ts';
import { writePrivateConfig } from './private-config.ts';
import type { Store } from './store.ts';
import { publicUrl, readPublicPage, type PageReaderDependencies } from './web-page-reader.ts';

type Context = { signal?: AbortSignal; runId?: string; conversationId?: string };
type Month = {
  requests: number;
  billableRequests: number;
  uncertainRequests: number;
  reservedMilli: number;
  errors: number;
  noResults: number;
};
type Settings = { enabled: boolean; limitMilli: number };
type Dependencies = {
  fetch?: typeof fetch;
  lookup?: PageReaderDependencies['lookup'];
  now?: () => number;
  secretsDir?: string;
  timeoutMs?: number;
  writePrivate?: typeof writePrivateConfig;
};
const costMilli = 5;
const maximumBytes = 1024 * 1024;
const emptyMonth = (): Month => ({
  requests: 0,
  billableRequests: 0,
  uncertainRequests: 0,
  reservedMilli: 0,
  errors: 0,
  noResults: 0,
});
function validKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(value.trim())) throw new Error('Invalid Search Key.');
  return value.trim();
}
function text(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/<[^<>]*>/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .trim()
    : '';
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Search request cancelled.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Search request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Independent tools credential and conservative, persisted per-month spend reservations. */
export class WebSearchService {
  private settings: Settings = { enabled: false, limitMilli: 5000 };
  private months: Record<string, Month> = {};
  private invalidConfig = false;
  private readonly file: string;
  private key?: string;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private writes: Promise<unknown> = Promise.resolve();
  private updating = 0;
  private closed = false;
  constructor(
    private readonly store: Pick<Store, 'config' | 'setConfig'>,
    private readonly deps: Dependencies = {},
  ) {
    this.file = join(isolatedUserPath(deps.secretsDir ?? secretsDirectory()), 'web-search-deepseek.key');
    try {
      const settings = store.config<Settings>('webSearchSettings', this.settings);
      const months = store.config<Record<string, Month>>('webSearchUsage', {});
      if (
        !settings ||
        typeof settings.enabled !== 'boolean' ||
        !Number.isSafeInteger(settings.limitMilli) ||
        settings.limitMilli < 0 ||
        settings.limitMilli > 1000000000 ||
        !months ||
        typeof months !== 'object' ||
        Array.isArray(months)
      )
        throw new Error();
      for (const [month, value] of Object.entries(months)) {
        if (
          !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).length !== 6 ||
          Object.keys(emptyMonth()).some(
            (key) => !Number.isSafeInteger(value[key as keyof Month]) || value[key as keyof Month] < 0,
          ) ||
          value.reservedMilli !== value.uncertainRequests * costMilli ||
          value.billableRequests + value.uncertainRequests + value.noResults > value.requests ||
          value.errors > value.requests
        )
          throw new Error();
      }
      if (
        !Number.isSafeInteger(
          Object.values(months).reduce(
            (sum, month) => sum + month.reservedMilli + month.billableRequests * costMilli,
            0,
          ),
        )
      )
        throw new Error();
      this.settings = settings;
      this.months = months;
    } catch {
      // Preserve corrupt stored data and block spend rather than silently resetting a reservation.
      this.invalidConfig = true;
    }
    try {
      this.key = validKey(readFileSync(this.file, 'utf8'));
    } catch {
      this.key = undefined;
    }
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private month() {
    return new Date(this.now()).toISOString().slice(0, 7);
  }
  private usage() {
    return (this.months[this.month()] ??= emptyMonth());
  }
  private persist() {
    this.store.setConfig('webSearchUsage', this.months);
  }
  private reservedMilli() {
    return Object.values(this.months).reduce((sum, month) => sum + month.reservedMilli, 0);
  }
  view(): WebSearchView {
    const usage = this.usage();
    return {
      provider: 'deepseek',
      enabled: this.settings.enabled,
      configured: !!this.key,
      keyHint: this.key ? '••••' : undefined,
      monthlyLimitCny: this.settings.limitMilli / 1000,
      month: this.month(),
      usage: {
        requests: usage.requests,
        billableRequests: usage.billableRequests,
        uncertainRequests: Object.values(this.months).reduce((sum, month) => sum + month.uncertainRequests, 0),
        estimatedCostCny: (usage.billableRequests * costMilli) / 1000,
        reservedCny: this.reservedMilli() / 1000,
      },
    };
  }
  available(): boolean {
    return !this.invalidConfig && !this.closed && !this.updating && this.settings.enabled && !!this.key;
  }
  update(input: WebSearchUpdate): Promise<WebSearchView> {
    // Validate everything before changing the credential, settings, or active requests.
    let key: string | undefined;
    try {
      if (this.invalidConfig)
        throw new Error('Search settings or usage are invalid; repair local configuration before searching.');
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((name) => !['key', 'clearKey', 'enabled', 'monthlyLimitCny'].includes(name))
      )
        throw new Error('Invalid search settings.');
      if (input.key !== undefined && input.clearKey) throw new Error('Save or clear the Search Key, not both.');
      if (input.key !== undefined) key = validKey(input.key);
      if (
        (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
        (input.clearKey !== undefined && typeof input.clearKey !== 'boolean')
      )
        throw new Error('Invalid search settings.');
      if (
        input.monthlyLimitCny !== undefined &&
        (!Number.isFinite(input.monthlyLimitCny) ||
          input.monthlyLimitCny < 0 ||
          input.monthlyLimitCny > 1000000 ||
          Math.abs(input.monthlyLimitCny * 1000 - Math.round(input.monthlyLimitCny * 1000)) > 1e-6)
      )
        throw new Error('Monthly limit must use whole milli-yuan units.');
    } catch (error) {
      return Promise.reject(error);
    }
    this.updating++;
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Error('Search service is closed.');
        if (key !== undefined || input.clearKey || input.enabled === false) this.abort();
        if (key !== undefined || input.clearKey) {
          let before = '';
          try {
            before = readFileSync(this.file, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read Search Key file.');
          }
          try {
            await (this.deps.writePrivate ?? writePrivateConfig)(this.file, key ?? '', before);
          } catch {
            throw new Error('Cannot securely save Search Key; previous settings retained.');
          }
        }
        const settings = {
          ...this.settings,
          enabled: input.clearKey ? false : (input.enabled ?? (key !== undefined ? true : this.settings.enabled)),
          limitMilli:
            input.monthlyLimitCny !== undefined ? Math.round(input.monthlyLimitCny * 1000) : this.settings.limitMilli,
        };
        this.store.setConfig('webSearchSettings', settings);
        this.settings = settings;
        if (key !== undefined || input.clearKey) this.key = key;
        return this.view();
      })
      .finally(() => {
        this.updating--;
      });
    this.writes = write;
    return write;
  }
  private abort() {
    for (const controller of this.active) controller.abort();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort();
    await Promise.allSettled([...this.pending, this.writes]);
  }

  private async request(path: 'search' | 'fetch', body: object, context: Context, nonempty: (data: any) => boolean) {
    if (this.invalidConfig)
      throw new Error('Search settings or usage are invalid; repair local configuration before searching.');
    if (context.signal?.aborted) throw new Error('Search request cancelled.');
    if (!this.available()) throw new Error('Search is disabled or its separate Search Key is missing.');
    if (this.active.size >= 4) throw new Error('Too many active search requests.');
    const usage = this.usage();
    if (usage.billableRequests * costMilli + this.reservedMilli() + costMilli > this.settings.limitMilli)
      throw new Error('Search monthly budget reached.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.add(completion);
    const start = this.now();
    const requestId = randomUUID();
    const key = this.key!;
    let settled = false;
    let reserved = false;
    const timer = setTimeout(abort, this.deps.timeoutMs ?? 15000);
    const settle = (billable: boolean, noResults = false) => {
      const next = {
        ...usage,
        uncertainRequests: usage.uncertainRequests - 1,
        reservedMilli: usage.reservedMilli - costMilli,
        billableRequests: usage.billableRequests + Number(billable),
        noResults: usage.noResults + Number(noResults),
      };
      Object.assign(usage, next);
      try {
        this.persist();
      } catch {
        usage.uncertainRequests++;
        usage.reservedMilli += costMilli;
        usage.billableRequests -= Number(billable);
        usage.noResults -= Number(noResults);
        throw new Error('Cannot save search usage.');
      }
      settled = true;
    };
    try {
      usage.requests++;
      usage.uncertainRequests++;
      usage.reservedMilli += costMilli;
      try {
        this.persist();
        reserved = true;
      } catch {
        usage.requests--;
        usage.uncertainRequests--;
        usage.reservedMilli -= costMilli;
        throw new Error('Cannot reserve search budget.');
      }
      const response = await abortable(
        (this.deps.fetch ?? fetch)(`https://api.deepseek.com/v1/tools/${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.status !== 200) {
        settle(false);
        void response.body?.cancel().catch(() => {});
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'Search Key was rejected.'
            : 'Search provider request failed.',
        );
      }
      if (Number(response.headers.get('content-length')) > maximumBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Search response exceeded the size limit.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Search provider returned an unreadable response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), controller.signal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maximumBytes) throw new Error('Search response exceeded the size limit.');
          chunks.push(chunk.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      }
      let data: any;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('Search provider returned invalid data.');
      }
      if (path === 'search' ? !Array.isArray(data?.results) : typeof data?.content !== 'string')
        throw new Error('Search provider returned invalid data.');
      const billable = nonempty(data);
      settle(billable, !billable);
      return {
        data,
        key,
        receipt: {
          requestId,
          durationMs: Math.max(0, this.now() - start),
          estimatedCostCny: billable ? costMilli / 1000 : 0,
          truncated: false,
        },
      };
    } catch (error) {
      if (reserved) {
        usage.errors++;
        try {
          this.persist();
        } catch {}
      }
      if (controller.signal.aborted) throw new Error('Search request cancelled or timed out.');
      // Only locally generated errors may reach callers; transport errors can contain credentials.
      if (
        error instanceof Error &&
        /^(Search (?:Key was rejected|provider request failed|response exceeded the size limit|provider returned (?:invalid data|an unreadable response))\.|Cannot (?:save search usage|reserve search budget)\.)$/.test(
          error.message,
        )
      )
        throw error;
      throw new Error(
        settled
          ? 'Search provider request failed.'
          : 'Search outcome is uncertain; its budget reservation was retained.',
      );
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
      this.pending.delete(completion);
      finish();
    }
  }
  async search(input: WebSearchInput, context: Context = {}): Promise<WebSearchResponse> {
    const validate = (value: unknown) => {
      if (typeof value !== 'string') throw new Error('Search query must contain 1 to 128 characters.');
      const query = value.trim();
      if (!query || /[\ud800-\udfff]/u.test(query) || Array.from(query).length > 128 || /[\x00-\x1f\x7f]/.test(query))
        throw new Error('Search query must contain 1 to 128 characters.');
      return query;
    };
    const query = validate(input?.query);
    const englishQuery = input.englishQuery === undefined ? undefined : validate(input.englishQuery);
    const count = input.count ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Search count must be between 1 and 10.');
    if (!englishQuery || englishQuery.toLowerCase() === query.toLowerCase())
      return this.searchOne(query, count, context);
    const start = this.now();
    const queries = [query, englishQuery];
    const origins: WebSearchOrigin[] = ['query', 'englishQuery'];
    const englishSignal = AbortSignal.timeout(3000);
    const settled = await Promise.allSettled([
      this.searchOne(query, count, context),
      this.searchOne(englishQuery, count, {
        ...context,
        signal: context.signal ? AbortSignal.any([context.signal, englishSignal]) : englishSignal,
      }),
    ]);
    context.signal?.throwIfAborted();
    const successes = settled.flatMap((side) => (side.status === 'fulfilled' ? [side.value] : []));
    if (!successes.length) throw new Error('Both search queries failed.');
    const results: WebSearchResponse['results'] = [];
    const byUrl = new Map<string, (typeof results)[number]>();
    for (let index = 0; index < count; index++) {
      for (const [sideIndex, side] of settled.entries()) {
        const item = side.status === 'fulfilled' ? side.value.results[index] : undefined;
        if (!item) continue;
        const origin = origins[sideIndex]!;
        const existing = byUrl.get(item.url);
        if (existing) {
          if (!existing.origins!.includes(origin)) existing.origins!.push(origin);
        } else {
          const result = { ...item, origins: [origin] };
          byUrl.set(item.url, result);
          results.push(result);
        }
      }
    }
    return {
      query,
      requestId: successes[0]!.requestId,
      results,
      durationMs: Math.max(0, this.now() - start),
      estimatedCostCny: successes.reduce((sum, side) => sum + side.estimatedCostCny, 0),
      truncated: successes.some((side) => side.truncated),
      searches: settled.map((side, index) => ({
        query: queries[index]!,
        origin: origins[index]!,
        ...(side.status === 'fulfilled'
          ? {
              requestId: side.value.requestId,
              durationMs: side.value.durationMs,
              estimatedCostCny: side.value.estimatedCostCny,
              truncated: side.value.truncated,
            }
          : {
              error: 'Search failed or timed out; cost may be uncertain. Check search usage.',
              estimatedCostCny: null,
            }),
      })),
      ...(successes.length < 2
        ? {
            note: 'One query failed or timed out. Available results are included; any uncertain cost remains reserved.',
          }
        : {}),
    };
  }
  private async searchOne(query: string, count: number, context: Context): Promise<WebSearchResponse> {
    const { data, key, receipt } = await this.request(
      'search',
      { query, count, need_content: false },
      context,
      (value) => Array.isArray(value?.results) && value.results.length > 0,
    );
    const clean = (value: unknown) => text(value).split(key).join('[redacted]');
    let remaining = 16000;
    const results: WebSearchResponse['results'] = [];
    for (const result of (Array.isArray(data?.results) ? data.results : []).slice(0, count)) {
      if (!result || typeof result !== 'object') continue;
      let url: string;
      try {
        url = publicUrl(clean(result.url));
      } catch {
        continue;
      }
      const summary = clean(result.summary || result.snippet || result.content);
      const bounded = summary.slice(0, Math.min(2000, remaining));
      receipt.truncated ||= bounded.length < summary.length;
      remaining -= bounded.length;
      results.push({
        title: clean(result.title).slice(0, 300),
        url,
        summary: bounded,
        ...(typeof result.date === 'string' ? { date: clean(result.date).slice(0, 80) } : {}),
      });
    }
    receipt.truncated ||= Array.isArray(data?.results) && data.results.length > count;
    return { ...receipt, query, results };
  }
  async fetchPage(value: string, context: Context = {}): Promise<WebFetchResponse> {
    const url = publicUrl(value);
    try {
      const { data, key, receipt } = await this.request(
        'fetch',
        { url },
        context,
        (value) => typeof value?.content === 'string' && !!value.content.trim(),
      );
      const content = text(data?.content).split(key).join('[redacted]');
      if (!content.trim()) throw new Error('Search provider returned an empty page.');
      return {
        ...receipt,
        truncated: content.length > 32000,
        url,
        title: text(data?.title).split(key).join('[redacted]').slice(0, 300),
        content: content.slice(0, 32000),
      };
    } catch (error) {
      // A cancelled task or switched-off search stays that way; any other provider failure must not cost the page.
      if (context.signal?.aborted || !this.available()) throw error;
      const start = this.now();
      try {
        const page = await readPublicPage(
          url,
          { fetch: this.deps.fetch, lookup: this.deps.lookup, timeoutMs: this.deps.timeoutMs },
          context.signal,
        );
        return { requestId: randomUUID(), durationMs: Math.max(0, this.now() - start), estimatedCostCny: 0, ...page };
      } catch (direct) {
        throw new Error(
          `Could not read this page. Search provider: ${error instanceof Error ? error.message : 'request failed.'} Direct read: ${direct instanceof Error ? direct.message : 'request failed.'}`,
        );
      }
    }
  }
}
