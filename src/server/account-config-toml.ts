/** Walk TOML syntax, including dotted keys and inline tables, before filtering any value. Fail closed on unknown syntax. */
export function sanitizeCodexConfig(input: string): string {
  let offset = 0;
  let section: string[] = [];
  const output: string[] = [];
  const fail = (): never => {
    throw new Error('无法读取配置格式');
  };
  const space = (lines = false) => {
    while (offset < input.length) {
      if (/[ \t\r]/.test(input[offset]!) || (lines && input[offset] === '\n')) offset++;
      else if (input[offset] === '#') {
        while (offset < input.length && input[offset] !== '\n') offset++;
      } else break;
    }
  };
  const string = (key = false): string => {
    const start = offset;
    const quote = input[offset++]!;
    const triple = !key && input.slice(start, start + 3) === quote.repeat(3);
    if (triple) offset += 2;
    while (offset < input.length) {
      if (quote === '"' && input[offset] === '\\') {
        offset += 2;
        continue;
      }
      if (input[offset] === quote) {
        if (!triple) return input.slice(start, ++offset);
        if (input.slice(offset, offset + 3) === quote.repeat(3)) {
          offset += 3;
          // TOML permits one or two extra quotes at the end of a multiline string.
          for (let i = 0; i < 2 && input[offset] === quote; i++) offset++;
          return input.slice(start, offset);
        }
      }
      if (!triple && /[\r\n]/.test(input[offset]!)) fail();
      offset++;
    }
    return fail();
  };
  const keys = (): string[] => {
    const result: string[] = [];
    for (;;) {
      space();
      const quote = input[offset];
      if (quote === '"' || quote === "'") {
        const raw = string(true);
        result.push(quote === '"' ? (JSON.parse(raw) as string) : raw.slice(1, -1));
      } else {
        const key = /^[A-Za-z0-9_-]+/.exec(input.slice(offset))?.[0];
        if (!key) fail();
        result.push(key!);
        offset += key!.length;
      }
      space();
      if (input[offset] !== '.') return result;
      offset++;
    }
  };
  const denied = (path: string[]) =>
    path.some(
      (key, index) =>
        // Provider, server, profile and project names are user labels, not configuration keys.
        !(index === 1 && ['model_providers', 'mcp_servers', 'profiles', 'projects'].includes(path[0]!)) &&
        (/auth|credential|secret|password|api.?key|env.?key|login|account|organization|email|http.?headers|workspace.?id/i.test(
          key,
        ) ||
          /(?:^|_)keys?(?:_|$)/i.test(key) ||
          (/token/i.test(key) &&
            !/^(?:model_)?(?:max_output_tokens|auto_compact_token_limit|context_window)$/.test(key))),
    ) ||
    (path[0] === 'mcp_servers' && path.slice(2).some((key) => key === 'env'));
  const name = (path: string[]) => path.map((key) => JSON.stringify(key)).join('.');
  const value = (path: string[]): string => {
    space(true);
    if (input[offset] === '"' || input[offset] === "'") return string();
    if (input[offset] === '{') {
      offset++;
      const entries: string[] = [];
      space(true);
      while (input[offset] !== '}') {
        const key = keys();
        if (input[offset++] !== '=') fail();
        const child = value([...path, ...key]);
        if (!denied([...path, ...key])) entries.push(`${name(key)} = ${child}`);
        space(true);
        if (input[offset] === '}') break;
        if (input[offset++] !== ',') fail();
        space(true);
      }
      offset++;
      return `{ ${entries.join(', ')} }`;
    }
    if (input[offset] === '[') {
      offset++;
      const entries: string[] = [];
      space(true);
      while (input[offset] !== ']') {
        entries.push(value(path));
        space(true);
        if (input[offset] === ']') break;
        if (input[offset++] !== ',') fail();
        space(true);
      }
      offset++;
      return `[${entries.join(', ')}]`;
    }
    const raw = /^[^\n\r,#\]}]+/.exec(input.slice(offset))?.[0];
    if (!raw?.trim() || /[={}\["']/.test(raw)) return fail();
    const scalar = raw.trim();
    if (
      !/^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|0x[\da-fA-F](?:_?[\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.test(
        scalar,
      )
    )
      fail();
    offset += raw.length;
    return scalar;
  };
  while (offset < input.length) {
    space(true);
    if (offset === input.length) break;
    if (input[offset] === '[') {
      offset++;
      const array = input[offset] === '[';
      if (array) offset++;
      section = keys();
      if (input[offset++] !== ']' || (array && input[offset++] !== ']')) fail();
      if (!denied(section)) output.push(`${array ? '[[' : '['}${name(section)}${array ? ']]' : ']'}`);
    } else {
      const key = keys();
      if (input[offset++] !== '=') fail();
      const path = [...section, ...key];
      const sanitized = value(path);
      if (!denied(path)) output.push(`${name(key)} = ${sanitized}`);
    }
    space();
    if (offset < input.length && input[offset++] !== '\n') fail();
  }
  return output.join('\n') + '\n';
}
