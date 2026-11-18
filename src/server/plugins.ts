import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PluginInfo } from '../shared/types.ts';
const require = createRequire(import.meta.url);
const cache = new Map<string, { paths: string[]; signature: string; plugins: PluginInfo[] }>();
function signature(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const stat = statSync(path, { bigint: true });
        return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
}
export function installedPlugins(root: string): PluginInfo[] {
  root = resolve(root);
  const cached = cache.get(root);
  if (cached && cached.signature === signature(cached.paths)) return cached.plugins;
  const specs = [
    [
      'pi',
      '@earendil-works/pi-coding-agent',
      'Pi Agent',
      '可选多模型 Agent 运行时，配置提供商后使用',
      'runtime',
      'https://github.com/earendil-works/pi',
    ],
    ['sqlite', '', 'SQLite', '项目、对话、记忆、计划与执行历史', 'library', 'https://sqlite.org'],
    ['zod', 'zod', 'Zod', '接口参数校验', 'library', 'https://github.com/colinhacks/zod'],
    ['react', 'react', 'React', '本地工作台界面', 'library', 'https://react.dev'],
    ['electron', 'electron', 'Electron', 'Windows / macOS 桌面外壳', 'library', 'https://electronjs.org'],
  ];
  const paths = specs.filter(([, pkg]) => pkg).map(([, pkg]) => join(root, 'node_modules', pkg, 'package.json'));
  const installed: PluginInfo[] = specs.map(([id, pkg, name, description, kind, homepage]) => {
    let version: string | undefined;
    try {
      version = pkg
        ? JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version
        : process.versions.sqlite;
    } catch {
      try {
        const path = require.resolve(`${pkg}/package.json`);
        paths.push(path);
        version = JSON.parse(readFileSync(path, 'utf8')).version;
      } catch {}
    }
    if (id === 'electron') version ||= process.versions.electron;
    return {
      id,
      name,
      description,
      homepage,
      kind: kind as PluginInfo['kind'],
      installed: !!version,
      version,
      note: id === 'pi' ? '已安装不等于已配置模型认证；通过独立 Pi 配置接入。' : undefined,
    };
  });
  // Stat checks detect installs and removals without re-reading JSON each broadcast.
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(root, { paths, signature: signature(paths), plugins: installed });
  return installed;
}
