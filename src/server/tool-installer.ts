import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runtimeDirectories, runtimeRoot } from '../../scripts/runtime-paths.mjs';
import type { InstallableToolId, ToolInstallation } from '../shared/tool-installations.ts';
import { spawnTarget, terminateProcess } from './adapters/process.ts';

export type InstallationProgress = Pick<ToolInstallation, 'phase' | 'message'> &
  Partial<Pick<ToolInstallation, 'receivedBytes' | 'totalBytes'>>;
const scripts: Record<InstallableToolId, string> = {
  voice: 'setup-voice.mjs',
  'image-search': 'setup-image-search.mjs',
  'memory-search': 'setup-memory-search.mjs',
  markitdown: 'setup-markitdown.mjs',
};
const active = new Map<
  string,
  { promise: Promise<string>; listeners: Set<(progress: InstallationProgress) => void> }
>();

function installed(appRoot: string, tool: InstallableToolId): boolean {
  const required = {
    voice: ['sense-voice/model.int8.onnx', 'sense-voice/tokens.txt'],
    'image-search': ['model.onnx', 'vocab.txt', 'ocr/det.onnx', 'ocr/rec.onnx', 'ocr/keys.txt'],
    'memory-search': ['model.onnx', 'tokenizer.json'],
    markitdown: [process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python', '.pugport-ready'],
  }[tool];
  return runtimeDirectories(appRoot, tool).some((dir) => required.every((file) => existsSync(join(dir, file))));
}

/** Shared by the asynchronous catalog and the old synchronous settings endpoint. */
export function runToolInstaller(
  appRoot: string,
  tool: InstallableToolId,
  progress?: (progress: InstallationProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const key = `${resolve(appRoot)}:${tool}`;
  const existing = active.get(key);
  if (existing) {
    if (progress) existing.listeners.add(progress);
    return existing.promise;
  }
  const listeners = new Set(progress ? [progress] : []);
  const emit = (value: InstallationProgress) => {
    for (const listener of listeners) listener(value);
  };
  const promise = (async () => {
    if (signal?.aborted) throw new Error('installation-interrupted');
    emit({ phase: 'preparing', message: '正在准备安装组件。' });
    const child = await spawnTarget(
      {
        id: `component-${tool}`,
        label: 'Component installer',
        provider: 'pi',
        command: process.execPath,
        environment: 'native',
        enabled: true,
      },
      [join(appRoot, 'scripts', scripts[tool])],
      { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PUGPORT_RUNTIME_DIR: runtimeRoot(appRoot) } },
    );
    let aborted = signal?.aborted ?? false;
    const abort = () => {
      aborted = true;
      void terminateProcess(child).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (aborted) abort();
    let tail = '',
      pending = '';
    const timer = setTimeout(abort, 45 * 60_000);
    const consume = (line: string) => {
      if (!line.startsWith('PUGPORT_INSTALL_PROGRESS ')) return;
      try {
        const value = JSON.parse(line.slice('PUGPORT_INSTALL_PROGRESS '.length));
        if (!['preparing', 'downloading', 'verifying', 'installing'].includes(value.phase)) return;
        emit({
          phase: value.phase,
          message: String(value.message).slice(0, 200),
          ...(Number.isSafeInteger(value.receivedBytes) && value.receivedBytes >= 0
            ? { receivedBytes: value.receivedBytes }
            : {}),
          ...(Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 ? { totalBytes: value.totalBytes } : {}),
        });
      } catch {
        /* A log line is not a progress update. */
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      pending += text;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, end).trim());
        pending = pending.slice(end + 1);
      }
      if (pending.length > 4096) pending = '';
    });
    child.stderr.on('data', (text: string) => {
      tail = (tail + text).slice(-2048);
    });
    try {
      const code = await new Promise<number | null>((done, fail) => {
        child.once('close', done);
        child.once('error', fail);
      });
      if (aborted) throw new Error('installation-interrupted');
      if (code !== 0) {
        if (/Python 3\.10/.test(tail)) throw new Error('需要先安装 Python 3.10–3.14，再安装文档读取组件。');
        if (/checksum/i.test(tail)) throw new Error('下载文件校验未通过，请重试。');
        throw new Error('组件安装未完成，请检查网络连接和磁盘空间后重试。');
      }
      emit({ phase: 'verifying', message: '正在确认组件文件已安装。' });
      if (!installed(appRoot, tool)) throw new Error('组件文件不完整，未标记为安装成功，请重试。');
      return '组件已安装并验证。';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  })();
  active.set(key, { promise, listeners });
  void promise.finally(() => active.delete(key)).catch(() => undefined);
  return promise;
}
