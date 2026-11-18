export type BridgeCatalogTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
};

const callSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, description: 'Exact tool name returned by search_tools.' },
    arguments: { type: 'object', description: 'Arguments matching the complete inputSchema returned by search_tools.' },
  },
  required: ['name', 'arguments'],
  additionalProperties: false,
};

/** These wrappers expose only the current caller's authorized deferred tools. They grant no new permission. */
export const deferredBridgeTools: BridgeCatalogTool[] = [
  {
    name: 'search_tools',
    description:
      'Find authorized external MCP, GitHub and connector tools and their complete input schemas before calling them. Search by exact names or query words; use nextOffset to continue a page. Built-in tools and skills remain directly available.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50 },
        query: { type: 'string', maxLength: 500 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'call_read_only_tool',
    description:
      'Call an authorized read-only external tool using its exact name and schema from search_tools. The host rechecks its current read-only classification and scope; mutating tools are rejected.',
    inputSchema: callSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'call_tool',
    description:
      'Call an authorized external tool using its exact name and schema from search_tools. The host enforces the original tool permissions and required user confirmations. This wrapper does not authorize writes.',
    inputSchema: callSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export const deferredBridgeToolNames: string[] = deferredBridgeTools.map((tool) => tool.name);

const compareName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function ordered(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('Tool input schema exceeds the nesting limit.');
  if (Array.isArray(value)) return value.map((child) => ordered(child, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareName(a, b))
        .map(([key, child]) => [key, ordered(child, depth + 1)]),
    );
  return value;
}

/** Keep schemas complete and array order intact while making catalog serialization deterministic. */
export function sortBridgeTools(tools: readonly BridgeCatalogTool[]): BridgeCatalogTool[] {
  return tools
    .map((tool) => ({ ...tool, inputSchema: ordered(tool.inputSchema) as Record<string, unknown> }))
    .sort((a, b) => compareName(a.name, b.name));
}

export function searchBridgeTools(
  tools: readonly BridgeCatalogTool[],
  args: Record<string, unknown>,
): { tools: BridgeCatalogTool[]; total: number; nextOffset?: number } {
  if (
    !args ||
    Array.isArray(args) ||
    typeof args !== 'object' ||
    Object.keys(args).some((key) => !['names', 'query', 'offset', 'limit'].includes(key)) ||
    (args.names !== undefined &&
      (!Array.isArray(args.names) ||
        !args.names.length ||
        args.names.length > 50 ||
        args.names.some((name) => typeof name !== 'string' || !name.length))) ||
    (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500))
  )
    throw new Error('Invalid tool search arguments.');
  const offset = args.offset === undefined ? 0 : args.offset,
    limit = args.limit === undefined ? 5 : args.limit;
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error('Invalid tool search pagination.');
  const names = args.names === undefined ? undefined : new Set(args.names as string[]);
  const query = ((args.query as string | undefined) ?? '').normalize('NFKC').trim().toLowerCase();
  const words = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const matches = tools
    .filter((tool) => !names || names.has(tool.name))
    .map((tool) => {
      const name = tool.name.normalize('NFKC').toLowerCase(),
        description = (tool.description ?? '').normalize('NFKC').toLowerCase();
      if (query && (!words.length || words.some((word) => !name.includes(word) && !description.includes(word))))
        return { tool, score: -1 };
      const score =
        (query && name === query ? 10_000 : query && name.startsWith(query) ? 1_000 : 0) +
        words.reduce((sum, word) => sum + (name.includes(word) ? 100 : 1), 0);
      return { tool, score };
    })
    .filter((match) => match.score >= 0)
    .sort((a, b) => b.score - a.score || compareName(a.tool.name, b.tool.name));
  const page = matches.slice(offset, offset + limit).map(({ tool }) => ({
    ...tool,
    inputSchema: ordered(tool.inputSchema) as Record<string, unknown>,
  }));
  return {
    tools: page,
    total: matches.length,
    ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}),
  };
}
