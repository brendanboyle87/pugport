import { execFile } from './platform/test-process.ts';
import { traceToolStep, type ToolStepOptions } from '../shared/tool-steps.ts';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runtimeDirectories } from '../../scripts/runtime-paths.mjs';

/**
 * Read-only helpers every executor can call through the agent bridge: find files by name, search their
 * contents, and read office documents as text. Bundled tools: ripgrep (npm @vscode/ripgrep) and, when set up,
 * MarkItDown in .runtime/markitdown.
 */
const run = promisify(execFile);
// ripgrep's exit code 1 means a successful search with no matches.
const searchOutput = (operation: Promise<{ stdout: string }>): Promise<{ stdout: string }> =>
  operation.catch((error: { code?: number; stdout?: string }) => {
    if (error.code === 1) return { stdout: error.stdout ?? '' };
    throw error;
  });
const maxOutput = 60_000;
const documentTypes = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.msg', '.epub']);
const textTypes =
  /^\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|ya?ml|toml|ini|log|py|[jt]sx?|css|java|go|rs|c|cc|cpp|h|cs|rb|php|sh|ps1|sql)$/i;

export function ripgrep(): string | undefined {
  try {
    const path = (createRequire(import.meta.url)('@vscode/ripgrep') as { rgPath: string }).rgPath;
    // Packaged builds keep the binary outside the asar-less app folder layout npm installs it to.
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

async function folder(value: unknown, fallback: string): Promise<string> {
  const path = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!isAbsolute(path)) throw new Error('folder 需要绝对路径。');
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`文件夹不存在：${path}`);
  return path;
}

const limitOf = (value: unknown, fallback: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), max)) : fallback;

/** Folders never worth searching for a user's own files. */
const skippedFolders = [
  'node_modules',
  '.git',
  '__MACOSX',
  'AppData',
  'site-packages',
  '.venv',
  '.next',
  '.cache',
  '__pycache__',
  '$RECYCLE.BIN',
];
/** The skipped folder names that apply below `folder`: one the user chose to search inside still counts. */
export function skippedFoldersBelow(folder: string): string[] {
  const parts = folder.toLowerCase().split(/[\\/]+/);
  return skippedFolders.filter((name) => !parts.includes(name.toLowerCase()));
}
/** Lists paths whose names contain the query under the folder, defaulting to the project. */
export async function findFiles(
  args: Record<string, unknown>,
  projectPath: string,
  options: ToolStepOptions = {},
): Promise<string> {
  const query = await traceToolStep(
    options,
    'validate',
    '检查文件搜索范围',
    () => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 200) throw new Error('请用 query 给出要找的文件名关键词。');
      return query;
    },
    { scope: args.folder ?? projectPath, limit: args.limit },
  );
  const limit = limitOf(args.limit, 50, 200);
  const rg = ripgrep();
  const root = await traceToolStep(
    options,
    'ripgrep-scope',
    '检查 ripgrep 搜索范围',
    async () => {
      if (!rg) throw new Error('文件搜索组件不可用。');
      return folder(args.folder, projectPath);
    },
    { engine: 'ripgrep' },
  );
  const pattern = `*${query.replace(/[*?[\]{}]/g, '')}*`;
  const { stdout } = await traceToolStep(
    options,
    'ripgrep-files',
    '执行 ripgrep 文件搜索',
    () =>
      searchOutput(
        run(rg!, ['--files', '--hidden', '--no-messages', '--iglob', pattern, '--iglob', '!.git'], {
          cwd: root,
          timeout: 20_000,
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
    { engine: 'ripgrep', scope: root, limit },
    (result) => ({ count: result.stdout.split(/\r?\n/).filter(Boolean).length }),
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return `在 ${root} 中没有找到名字含“${query}”的文件。`;
  const shown = lines.slice(0, limit).map((line) => resolve(root, line));
  return `${root} 中名字含“${query}”的文件（${lines.length} 个${lines.length > limit ? `，显示前 ${limit} 个` : ''}）：\n${shown.join('\n')}`;
}

/** Searches file contents with ripgrep: matching lines with paths and line numbers, bounded. */
export async function searchText(
  args: Record<string, unknown>,
  projectPath: string,
  options: ToolStepOptions = {},
): Promise<string> {
  const pattern = await traceToolStep(options, 'validate', '检查内容搜索条件', () => {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern.trim() || pattern.length > 500) throw new Error('请用 pattern 给出要搜索的文字。');
    return pattern;
  });
  const rg = ripgrep();
  const root = await traceToolStep(
    options,
    'ripgrep-scope',
    '检查内容搜索范围',
    async () => {
      if (!rg) throw new Error('内容搜索组件不可用。');
      return folder(args.folder, projectPath);
    },
    { engine: 'ripgrep' },
  );
  const limit = limitOf(args.limit, 50, 300);
  const glob = typeof args.glob === 'string' && args.glob.trim() ? ['--iglob', args.glob.trim()] : [];
  const { stdout } = await traceToolStep(
    options,
    'ripgrep-text',
    '执行 ripgrep 内容搜索',
    () =>
      searchOutput(
        run(
          rg!,
          [
            '-n',
            '-S',
            '--no-messages',
            '--max-count',
            '5',
            '--max-columns',
            '300',
            '--max-columns-preview',
            ...glob,
            '-e',
            pattern,
            '.',
          ],
          { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
        ),
      ),
    { engine: 'ripgrep', scope: root, limit },
    (result) => ({ count: result.stdout.split(/\r?\n/).filter(Boolean).length }),
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return `在 ${root} 中没有找到“${pattern}”。`;
  return `${root} 中的匹配（${lines.length} 行${lines.length > limit ? `，显示前 ${limit} 行` : ''}）：\n${lines.slice(0, limit).join('\n')}`;
}

/** The MarkItDown interpreter set up by scripts/setup-markitdown.mjs, if present. */
export function markitdown(root: string): string | undefined {
  return runtimeDirectories(root, 'markitdown')
    .filter((dir) => existsSync(join(dir, '.pugport-ready')))
    .map((dir) => join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    .find((python) => existsSync(python));
}

let conversions = 0;
export const markitdownInUse = () => conversions > 0;

/** Office documents and PDFs become Markdown through MarkItDown; text files are read as they are. */
export async function readDocument(
  args: Record<string, unknown>,
  projectPath: string,
  appRoot: string,
  options: ToolStepOptions = {},
): Promise<string> {
  const { path, info } = await traceToolStep(
    options,
    'validate',
    '检查文档范围和大小',
    async () => {
      const value = typeof args.path === 'string' ? args.path.trim() : '';
      if (!value) throw new Error('请用 path 给出文件路径。');
      const path = isAbsolute(value) ? value : resolve(projectPath, value);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`文件不存在：${path}`);
      if (info.size > 200 * 1024 * 1024) throw new Error('文件超过 200 MB，未读取。');
      return { path, info };
    },
    undefined,
    (result) => ({ scope: result.path, bytes: result.info.size }),
  );
  const type = extname(path).toLowerCase();
  let text: string;
  if (documentTypes.has(type)) {
    const { stdout } = await traceToolStep(
      options,
      'convert-document',
      '用 MarkItDown 提取文档文字',
      async () => {
        const python = markitdown(appRoot);
        if (!python) throw new Error('请先安装「读取本机办公文档」组件。');
        conversions++;
        try {
          return await run(python, ['-m', 'markitdown', path], {
            timeout: 120_000,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
            windowsHide: true,
          });
        } finally {
          conversions--;
        }
      },
      { engine: 'MarkItDown', scope: path },
      (result) => ({ characters: result.stdout.length }),
    );
    text = stdout;
  } else if (textTypes.test(type) || info.size < 2 * 1024 * 1024) {
    text = await traceToolStep(
      options,
      'read-text',
      '读取文本文件',
      () => readFile(path, 'utf8'),
      { engine: 'filesystem', scope: path },
      (result) => ({ characters: result.length }),
    );
  } else
    return traceToolStep(options, 'read-document', '读取文档', () => {
      throw new Error(`不支持的文件类型：${type || '无扩展名'}`);
    });
  const trimmed = text.trim();
  if (!trimmed) return `${path} 没有可提取的文字（可能是扫描件或图片）。`;
  return trimmed.length > maxOutput
    ? `${trimmed.slice(0, maxOutput)}\n\n（内容较长，已截取前 ${maxOutput} 字；全文 ${trimmed.length} 字。）`
    : trimmed;
}

/** Which local helpers are available, for the settings page. */
export function localToolStatus(appRoot: string) {
  return {
    ripgrep: !!ripgrep(),
    markitdown: !!markitdown(appRoot),
  } as const;
}
