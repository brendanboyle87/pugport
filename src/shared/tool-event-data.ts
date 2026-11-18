type Row = Record<string, unknown>;
/** Explicit tool names only; ACP event titles can contain entire commands or file contents. */
export function safeToolName(data?: Row): string | undefined {
  const name = data?.tool ?? data?.name ?? data?.toolName;
  return typeof name === 'string' && /^[\w./:-]{1,100}$/.test(name) ? name : undefined;
}

const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const hidden =
  /^(?:_meta|system|developer|system[_-]?prompt|developer[_-]?prompt|reasoning|thinking|analysis|internal|private[_-]?(?:field|data|reasoning)|messages|signature|base64|blob)$/i;
const secret =
  /secret|password|passwd|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|token/i;

export const toolEventCaptureLimit = 4 * 1024 * 1024;
export function safeToolEventText(value: string, limit = toolEventCaptureLimit): string {
  const safe = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(
      /<(?:system|developer|reasoning|thinking|analysis|internal)(?!\w)[^>]*>[\s\S]*?(?:<\/(?:system|developer|reasoning|thinking|analysis|internal)>|$)/gi,
      '[private content omitted]',
    )
    .replace(/-----BEGIN [^-]*PRIVATE KEY[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[redacted]')
    .replace(/\b(?:sk|pk|xai)-[\w-]+|\bgh[pousr]_[\w]+|\bgithub_pat_[\w]+|\bxox[baprs]-[\w-]+/gi, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[redacted]')
    .replace(
      /(["']?\b[\w.-]{0,200}(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|token|password|secret|authorization|credentials?|cookie)[\w.-]{0,100}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/data:[^\s;,]*;base64,[A-Za-z0-9+/=]+/gi, '[binary content omitted]');
  return safe.length > limit ? safe.slice(0, Math.max(0, limit)) + '\n[capture truncated: text size limit]' : safe;
}

/** Only use on an explicit tool argument/result field, never an entire native packet. */
export function safeToolEventValue(value: unknown, options: { full?: boolean } = { full: true }): unknown {
  const budget = {
    nodes: options.full === false ? 150 : 100000,
    characters: options.full === false ? 16000 : toolEventCaptureLimit,
  };
  const maxDepth = options.full === false ? 5 : 20;
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > maxDepth || budget.nodes-- <= 0 || budget.characters <= 0)
      return '[capture truncated: structural or size limit]';
    if (typeof item === 'string') {
      const safe = safeToolEventText(item, budget.characters);
      budget.characters -= safe.length;
      return safe;
    }
    if (typeof item === 'number') return Number.isFinite(item) ? item : undefined;
    if (typeof item === 'boolean' || item === null) return item;
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const child of item) {
        if (budget.nodes <= 0 || budget.characters <= 0) {
          result.push('[capture truncated: structural or size limit]');
          break;
        }
        result.push(visit(child, depth + 1));
      }
      return result;
    }
    if (!item || typeof item !== 'object') return undefined;
    let object = row(item);
    // Grok's native Bash result encodes stdout as UTF-8 bytes. Normalize before
    // visiting fields so credentials cannot bypass text redaction as numbers.
    if (
      object.type === 'Bash' &&
      Array.isArray(object.output) &&
      object.output.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      const bytes = object.output;
      try {
        object = {
          ...object,
          output: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)),
          outputEncoding: 'utf-8',
          outputByteLength: bytes.length,
        };
      } catch {
        object = {
          ...object,
          output: '[binary native Bash output omitted: invalid UTF-8]',
          outputEncoding: 'binary-omitted',
          outputByteLength: bytes.length,
        };
      }
    }
    if (
      ['system', 'developer', 'reasoning', 'analysis', 'thinking'].includes(
        String(object.role ?? object.type).toLowerCase(),
      )
    )
      return '[private content omitted]';
    if (['image', 'audio', 'resource', 'resource_link'].includes(String(object.type)))
      return '[non-text tool content omitted]';
    const result: Row = {};
    for (const [key, child] of Object.entries(object)) {
      if (hidden.test(key)) continue;
      if (budget.nodes <= 0 || budget.characters <= 0) {
        result.captureTruncated = 'Structural or size limit';
        break;
      }
      const safeKey = safeToolEventText(key, budget.characters);
      budget.characters -= safeKey.length;
      Object.defineProperty(result, safeKey, {
        value: secret.test(key) ? '[redacted]' : visit(child, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  return visit(value, 0);
}

/** ACP/user-result display fields only. Keep input and output budgets independent. */
export function toolEventDetails(value: Row): Row {
  const result: Row = {};
  const input = value.rawInput ?? value.input ?? value.args;
  const output = value.rawOutput ?? value.output ?? value.result ?? value.content;
  if (input !== undefined) result.input = safeToolEventValue(input);
  if (output !== undefined && !(Array.isArray(output) && output.length === 0))
    result.output = safeToolEventValue(output);
  const exitCode = value.exitCode ?? row(value.rawOutput).exitCode ?? row(value.rawOutput).exit_code;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) result.exitCode = exitCode;
  if (
    value.isError === true ||
    value.is_error === true ||
    row(value.rawOutput).isError === true ||
    row(value.rawOutput).is_error === true
  )
    result.isError = true;
  return result;
}
