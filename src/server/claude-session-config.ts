import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeTarget } from '../shared/types.ts';
import { isolatedUserPath } from './platform/under-test.ts';

// Native sessions keep Claude's own config watchers. This digest also invalidates idle reuse
// when startup instructions, extensions, or declared local configuration change.
async function fingerprint(target: RuntimeTarget, cwd: string, env = process.env): Promise<string | undefined> {
  if (target.environment !== 'native' || target.args?.length) return;
  const deadline = performance.now() + 1_000;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const hash = createHash('sha256');
    const home = isolatedUserPath(env.USERPROFILE || env.HOME || homedir());
    const config = isolatedUserPath(resolve(target.accountHome || env.CLAUDE_CONFIG_DIR || join(home, '.claude')));
    const seen = new Map<string, string | undefined>();
    const catalogs = new Set<string>();
    const enabledPlugins = new Set<string>();
    const extraMemory = new Set<string>();
    let entries = 0;
    let bytes = 0;
    const check = () => {
      if (expired || performance.now() >= deadline || ++entries > 2_048 || bytes > 8 * 1024 * 1024)
        throw new Error('configuration-snapshot-limit');
    };
    const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
    const expand = (file: string, base: string) => resolve(base, file.replace(/^~[/\\]/, home + '/'));
    const readBounded = async (file: string, limit: number) => {
      check();
      const handle = await open(file, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > limit) throw new Error('configuration-file-limit');
        bytes += before.size;
        check();
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          check();
          const result = await handle.read(buffer, length, buffer.length - length, length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        check();
        const after = await handle.stat();
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw new Error('configuration-changed-during-read');
        return buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
    };
    const checkHooks = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'async' || key === 'asyncRewake') && child === true) throw new Error('background-hook');
        checkHooks(child);
      }
    };
    const importsFrom = async (text: string, file: string, depth: number) => {
      if (depth < 0 || depth >= 4) return;
      const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`/g, '');
      for (const match of prose.matchAll(/(?:^|[\s(])@((?:\\[ \t]|[^\s<>`'"])+)/gm)) {
        const reference = match[1].replace(/\\([ \t])/g, '$1');
        if (reference.includes('://')) continue;
        await visit(expand(reference, dirname(file)), depth + 1);
      }
    };
    const visit = async (file: string, imports = -1): Promise<string | undefined> => {
      check();
      file = isolatedUserPath(resolve(file));
      hash.update(file + '\0');
      let info;
      try {
        info = await lstat(file);
      } catch (error) {
        if (!missing(error)) throw error;
        hash.update('missing\0');
        return;
      }
      const canonical = await realpath(file);
      hash.update(canonical + '\0');
      if (seen.has(canonical)) {
        const cached = seen.get(canonical);
        if (cached) await importsFrom(cached, file, imports);
        return cached;
      }
      seen.set(canonical, undefined);
      if (info.isSymbolicLink()) info = await stat(file);
      if (info.isDirectory()) {
        const children = (await readdir(file)).sort();
        check();
        if (children.length > 2_048) throw new Error('configuration-directory-limit');
        for (const child of children) await visit(join(file, child), imports);
        return;
      }
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('configuration-file-limit');
      const content = await readBounded(file, 4 * 1024 * 1024);
      check();
      hash.update(content).update('\0');
      const text = content.toString('utf8');
      seen.set(canonical, text);
      await importsFrom(text, file, imports);
      return text;
    };
    const catalog = async (directory: string, skills = false) => {
      check();
      directory = isolatedUserPath(resolve(directory));
      hash.update(directory + '\0');
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!missing(error)) throw error;
        hash.update('missing\0');
        return;
      }
      const canonical = await realpath(directory);
      hash.update(canonical + '\0');
      const key = canonical + ':' + skills;
      if (catalogs.has(key)) return;
      catalogs.add(key);
      if (children.length > 2_048) throw new Error('configuration-directory-limit');
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(directory, child.name);
        const directoryEntry = child.isDirectory() || (child.isSymbolicLink() && (await stat(file)).isDirectory());
        if (skills && directoryEntry) await visit(join(file, 'SKILL.md'));
        else if (directoryEntry) await catalog(file);
        else if (child.name.endsWith('.md')) await visit(file);
      }
    };
    const settings = async (file: string) => {
      const text = await visit(file);
      if (!text) return;
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-settings');
      const object = value as Record<string, unknown>;
      checkHooks(object.hooks);
      if (object.enabledPlugins && typeof object.enabledPlugins === 'object')
        for (const [name, enabled] of Object.entries(object.enabledPlugins)) if (enabled) enabledPlugins.add(name);
      if (typeof object.autoMemoryDirectory === 'string') {
        const memory = object.autoMemoryDirectory;
        if (!isAbsolute(memory) && !memory.startsWith('~/')) throw new Error('unknown-memory-path');
        extraMemory.add(expand(memory, cwd));
      }
      // A helper may obtain policy from outside the files being sampled; let a new CLI load it.
      if (object.managedSettingsHelper) throw new Error('dynamic-managed-settings');
    };
    const configuration = async (directory: string) => {
      await settings(join(directory, 'settings.json'));
      await settings(join(directory, 'settings.local.json'));
      await visit(join(directory, 'CLAUDE.md'), 0);
      await catalog(join(directory, 'skills'), true);
      for (const name of ['rules', 'agents', 'commands', 'output-styles']) await catalog(join(directory, name));
    };
    // Only the digest leaves this function; environment values and config bodies are never logged.
    hash.update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))));
    await configuration(config);
    const roots: string[] = [];
    for (let root = resolve(cwd); ; root = dirname(root)) {
      roots.push(root);
      if (dirname(root) === root) break;
    }
    for (const root of roots.reverse()) {
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) await visit(join(root, name), 0);
      await configuration(join(root, '.claude'));
    }
    const managed = isolatedUserPath(
      process.platform === 'win32'
        ? join(env.ProgramFiles || 'C:/Program Files', 'ClaudeCode')
        : process.platform === 'darwin'
          ? '/Library/Application Support/ClaudeCode'
          : '/etc/claude-code',
    );
    await settings(join(managed, 'managed-settings.json'));
    const fragments = join(managed, 'managed-settings.d');
    let fragmentNames: string[];
    try {
      fragmentNames = await readdir(fragments);
    } catch (error) {
      if (!missing(error)) throw error;
      fragmentNames = [];
    }
    if (fragmentNames.length > 256) throw new Error('managed-fragment-limit');
    for (const name of fragmentNames.sort()) if (name.endsWith('.json')) await settings(join(fragments, name));
    await visit(join(managed, 'CLAUDE.md'), 0);
    const registry = await visit(join(config, 'plugins', 'installed_plugins.json'));
    if (enabledPlugins.size) {
      if (!registry) throw new Error('plugin-registry-missing');
      const installed = JSON.parse(registry) as { plugins?: Record<string, Array<{ installPath?: string }>> };
      for (const name of [...enabledPlugins].sort()) {
        const records = installed.plugins?.[name];
        if (!records?.length) throw new Error('plugin-path-unknown');
        for (const record of records) {
          if (!record.installPath || !isAbsolute(record.installPath)) throw new Error('plugin-path-unknown');
          const manifestText = await visit(join(record.installPath, '.claude-plugin/plugin.json'));
          await configuration(record.installPath);
          const hookText = await visit(join(record.installPath, 'hooks/hooks.json'));
          if (hookText) checkHooks(JSON.parse(hookText));
          if (manifestText) {
            const manifest = JSON.parse(manifestText) as Record<string, unknown>;
            for (const name of ['skills', 'commands', 'agents', 'outputStyles', 'hooks']) {
              const paths = manifest[name];
              for (const file of Array.isArray(paths) ? paths : paths ? [paths] : []) {
                if (name === 'hooks' && typeof file === 'object') {
                  checkHooks(file);
                  continue;
                }
                if (typeof file !== 'string') throw new Error('unknown-plugin-declaration');
                const declared = expand(file, record.installPath);
                const info = await stat(isolatedUserPath(declared));
                if (info.isDirectory()) await catalog(declared, name === 'skills');
                else {
                  const text = await visit(declared);
                  if (name === 'hooks' && text) checkHooks(JSON.parse(text));
                }
              }
            }
          }
        }
      }
    }
    if (env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD) throw new Error('additional-instruction-scope');
    // Worktrees share the main checkout's memory; don't enumerate unrelated projects/transcripts.
    const projectRoots = new Set(roots);
    for (const root of roots) {
      try {
        check();
        const gitFile = isolatedUserPath(join(root, '.git'));
        const git = await stat(gitFile);
        if (!git.isFile()) continue;
        const text = (await readBounded(gitFile, 16_384)).toString('utf8');
        check();
        const location = /^gitdir:\s*(.+)\s*$/m.exec(text)?.[1];
        if (location) {
          const directory = resolve(root, location.trim());
          if (dirname(directory).endsWith('worktrees')) projectRoots.add(dirname(dirname(dirname(directory))));
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const projectNames = env.CLAUDE_CODE_PROJECT_DIR_NAME
      ? [env.CLAUDE_CODE_PROJECT_DIR_NAME]
      : [...projectRoots].map((root) => root.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const name of projectNames.sort()) await visit(join(config, 'projects', name, 'memory', 'MEMORY.md'));
    for (const memory of extraMemory) await visit(join(memory, 'MEMORY.md'));
    check();
    return hash.digest('hex');
  };
  try {
    return await Promise.race([
      work().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(undefined);
        }, 1_000);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}

export const claudeSessionConfig = { fingerprint };
