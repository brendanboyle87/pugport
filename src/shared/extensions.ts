/*
 * Extensions the user installs once for every executor: skills (folders with a SKILL.md: instructions, plus
 * any scripts and references they mention) and tools (MCP servers, local commands or remote addresses).
 * PugPort hosts them; executors reach them through its own tool bridge.
 */

import type { Locale } from './i18n/index.ts';
import type { SkillSummary } from './skill-summaries.ts';

export type ExtensionTool = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema?: Record<string, unknown>;
};

export type SyncOrigin = 'claude' | 'codex' | 'agents' | 'claude-plugin' | 'claude-desktop' | 'pugport';
export type SyncSource = { origin: SyncOrigin; file: string; key: string; plugin?: string };
export type SyncState = { sources: SyncSource[]; removedAt?: string };

export type SkillExtension = {
  kind: 'skill';
  id: string;
  name: string;
  description: string;
  summaries?: Partial<Record<Locale, SkillSummary>>;
  /** The skill's folder. */
  path: string;
  /** Where it came from: a link, or the folder or file it was installed from. */
  source: string;
  /** PugPort owns the folder (a copy it made) and removes it on uninstall; imported folders stay where they are. */
  managed: boolean;
  enabled: boolean;
  installedAt: string;
  sync?: SyncState;
  loginSensitive?: boolean;
  rewrittenPath?: string;
  pluginRoot?: string;
};

export type McpExtension = {
  kind: 'mcp';
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  /** Values never leave the server; the page sees only which names are set. */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  source: string;
  enabled: boolean;
  installedAt: string;
  sync?: SyncState;
  launchApproval?: string;
  /** Server-only argument and URL substitutions. */
  secretValues?: { args?: Record<string, string>; url?: Record<string, string> };
  /** What the server offered when last checked. */
  tools?: ExtensionTool[];
  checkedAt?: string;
  error?: string;
};

export type Extension = SkillExtension | McpExtension;

/** What the page sees: secret values replaced by whether they are filled in. */
export type ExtensionView =
  | SkillExtension
  | (Omit<McpExtension, 'env' | 'headers' | 'launchApproval' | 'secretValues'> & {
      env?: Record<string, boolean>;
      headers?: Record<string, boolean>;
      needsApproval?: boolean;
    });

/** One thing found in a link, folder, pasted configuration or another app, before it is installed. */
export type ExtensionDraft = {
  key: string;
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  /** Where it was found, e.g. “GitHub anthropics/skills” or “Claude Desktop”. */
  origin: string;
  /** What will run, for a tool: the command line or address. */
  detail?: string;
  /** Settings the user must fill in first (empty or placeholder values). */
  needs?: string[];
  /** The names of settings that already have values. */
  filled?: string[];
  installed?: boolean;
  /** Same-name installation that the user may explicitly choose to replace. */
  existingId?: string;
  license?: string;
};

export type ExtensionPreview = { token: string; drafts: ExtensionDraft[]; notes?: string[] };

/** Per-draft choices. MCP installs add an instance unless replacement is explicitly requested. */
export type ExtensionInstallOptions = Record<string, { name?: string; replaceId?: string }>;

/** A starting point for the future store: open-licensed extensions, fetched from their source when installed. */
export type CatalogEntry = {
  id: string;
  kind: 'skill' | 'mcp';
  title: string;
  description: string;
  /** What gets installed: a link for skills, a configuration for tools. */
  install: string;
  homepage: string;
  license: string;
};

export const extensionCatalog: CatalogEntry[] = [
  {
    id: 'internal-comms',
    kind: 'skill',
    title: '工作沟通文稿',
    description: '按固定格式写周报、项目进展、通知、事故说明等工作沟通内容。',
    install: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms',
    license: 'Apache-2.0',
  },
  {
    id: 'canvas-design',
    kind: 'skill',
    title: '海报与视觉设计',
    description: '按设计思路生成海报、封面等静态视觉作品（PNG 或 PDF）。',
    install: 'https://github.com/anthropics/skills/tree/main/skills/canvas-design',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/canvas-design',
    license: 'Apache-2.0',
  },
  {
    id: 'theme-factory',
    kind: 'skill',
    title: '文档与幻灯片配色主题',
    description: '给幻灯片、文档、报告和网页套用一套协调的配色与字体主题。',
    install: 'https://github.com/anthropics/skills/tree/main/skills/theme-factory',
    homepage: 'https://github.com/anthropics/skills/tree/main/skills/theme-factory',
    license: 'Apache-2.0',
  },
  {
    id: 'browser',
    kind: 'mcp',
    title: '网页自动操作',
    description:
      '让 AI 打开网页、点击、填写、截图和读取页面内容。使用独立的临时浏览器资料，不碰你的浏览器登录状态。首次使用会自动下载组件。',
    install: JSON.stringify({
      mcpServers: {
        browser: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--isolated'] },
      },
    }),
    homepage: 'https://github.com/microsoft/playwright-mcp',
    license: 'Apache-2.0',
  },
];
