import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import type { CatalogEntry } from '../shared/extensions';
import type { InstallableToolId, ToolInstallation } from '../shared/tool-installations';
import { SettingsRow } from './SettingsRow';
import { confirmDialog } from './confirm-dialog';
import { translateInterfaceText } from './i18n';
import type { Api, Notice } from './Workspace';

export type LocalComponentId = InstallableToolId;
export type Installation = ToolInstallation;
type LocalInfo = {
  tools: {
    voice?: boolean;
    images?: { model: boolean };
    memory?: { model: boolean };
    markitdown?: boolean;
  };
};
type Kind = 'local' | 'skill' | 'mcp';
export type DiscoveryEntry = {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  detail: string;
  source: string;
  sourceLabel: string;
  footprint?: string;
  tool?: LocalComponentId;
  catalog?: CatalogEntry;
};

export const localComponents: DiscoveryEntry[] = [
  {
    id: 'local-voice',
    kind: 'local',
    tool: 'voice',
    title: '视频转写',
    description: '视频没有字幕时，在这台电脑上把声音转成文字。',
    detail:
      '安装 SenseVoice 语音模型，适用 FunASR 模型许可；Sherpa-ONNX 识别引擎适用 Apache-2.0。用于视频无字幕时的本地转写，识别时音频留在本机。',
    source: 'https://github.com/FunAudioLLM/SenseVoice',
    sourceLabel: 'SenseVoice · FunASR 模型许可',
    footprint: '安装占用约 240 MB',
  },
  {
    id: 'local-images',
    kind: 'local',
    tool: 'image-search',
    title: '图片搜索与识字',
    description: '按图片、描述或图中的文字，寻找本机图片。',
    detail: '安装 Chinese-CLIP 和 OCR 模型。图片在本地分析；未安装时仍能匹配相同或几乎相同的图片。',
    source: 'https://github.com/OFA-Sys/Chinese-CLIP',
    sourceLabel: 'Chinese-CLIP / PaddleOCR · MIT / Apache-2.0',
    footprint: '安装占用约 210 MB',
  },
  {
    id: 'local-memory',
    kind: 'local',
    tool: 'memory-search',
    title: '按意思想起旧对话',
    description: '让 AI 自动找到相关的旧对话',
    detail:
      '安装 bge-m3 文本模型，供 AI 按意思检索旧对话。搜索框仍按关键词搜索；未安装模型时，AI 也按关键词检索，不影响历史保存。',
    source: 'https://huggingface.co/BAAI/bge-m3',
    sourceLabel: 'BAAI bge-m3 · MIT',
    footprint: '安装占用约 590 MB',
  },
  {
    id: 'local-documents',
    kind: 'local',
    tool: 'markitdown',
    title: '读取本机办公文档',
    description: '从 PDF、Word、Excel 和 PPT 中提取文字。',
    detail: '使用独立的 MarkItDown 环境，需要本机 Python 3.10–3.14。扫描件仍可能需要 OCR；这里不连接云端账号。',
    source: 'https://github.com/microsoft/markitdown',
    sourceLabel: 'Microsoft MarkItDown · MIT',
    footprint: '安装占用依赖 Python 环境',
  },
];
export function discoveryEntries(catalog: CatalogEntry[]): DiscoveryEntry[] {
  return [
    ...localComponents,
    ...catalog.map((entry) => ({
      id: `extension-${entry.id}`,
      kind: entry.kind,
      title: entry.title,
      description: entry.description,
      detail: '',
      source: entry.homepage,
      sourceLabel: `来源 · ${entry.license}`,
      catalog: entry,
    })),
  ];
}
export function localComponentReady(tool: LocalComponentId, info?: LocalInfo): boolean {
  if (!info) return false;
  if (tool === 'voice') return info.tools.voice === true;
  if (tool === 'image-search') return info.tools.images?.model === true;
  if (tool === 'memory-search') return info.tools.memory?.model === true;
  if (tool === 'markitdown') return info.tools.markitdown === true;
  return false;
}

/** Task state comes from the server, so moving between pages does not lose a download. */
export function useLocalComponents(api: Api, notify: (notice: Notice) => void) {
  const [info, setInfo] = useState<LocalInfo>();
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<LocalComponentId>();
  const [removing, setRemoving] = useState<LocalComponentId>();
  const removal = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const [state, jobs] = await Promise.all([
        api<LocalInfo>('/api/app-info', undefined, 'GET'),
        api<{ installations: Installation[] }>('/api/tool-installations', undefined, 'GET'),
      ]);
      if (current !== sequence.current) return;
      setInfo(state);
      setInstallations(jobs.installations);
      setError('');
    } catch (reason) {
      if (current === sequence.current) setError(reason instanceof Error ? reason.message : '本地组件状态读取失败。');
    }
  }, [api]);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    return () => {
      sequence.current++;
      window.removeEventListener('focus', refresh);
    };
  }, [load]);
  const running = installations.some((job) => job.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [running, load]);
  const start = async (tool: LocalComponentId) => {
    if (removal.current || starting || installations.some((job) => job.tool === tool && job.status === 'running'))
      return;
    setStarting(tool);
    try {
      const { installation } = await api<{ installation: Installation }>('/api/tool-installations', { tool });
      setInstallations((jobs) => [installation, ...jobs.filter((job) => job.id !== installation.id)]);
      await load();
    } catch (reason) {
      notify({ tone: 'error', message: reason instanceof Error ? reason.message : '无法开始安装。' });
    } finally {
      setStarting(undefined);
    }
  };
  const remove = async (entry: DiscoveryEntry) => {
    if (!entry.tool || removal.current || starting) return;
    removal.current = true;
    setRemoving(entry.tool);
    const names = [translateInterfaceText(entry.title)];
    try {
      if (
        !(await confirmDialog({
          title: '卸载「{0}」？',
          names,
          summary: '会删除下载的组件文件。之后需要时可以重新安装。',
          action: '卸载',
          tone: 'danger',
        }))
      )
        return;
      try {
        await api(`/api/tool-installations/${entry.tool}`, undefined, 'DELETE');
        notify({ tone: 'success', message: '已卸载「{0}」。', names });
      } finally {
        await load();
      }
    } catch (reason) {
      notify({ tone: 'error', message: reason instanceof Error ? reason.message : '无法卸载组件。' });
    } finally {
      removal.current = false;
      setRemoving(undefined);
    }
  };
  return { info, installations, error, starting, removing, load, start, remove };
}
export type LocalComponentsState = ReturnType<typeof useLocalComponents>;
export function ExtensionCatalog({
  entries,
  local,
  installed,
  busy,
  onInstall,
}: {
  entries: DiscoveryEntry[];
  local: LocalComponentsState;
  installed: Set<string>;
  busy?: string;
  onInstall: (entry: CatalogEntry) => void;
}) {
  const latest = (tool: LocalComponentId) =>
    [...local.installations]
      .filter((job) => job.tool === tool)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return (
    <div className="extension-discovery">
      {local.error && (
        <div className="ext-load-error" role="alert">
          <span>本地组件状态读取失败：{local.error}</span>
          <button type="button" className="button quiet tiny" onClick={() => void local.load()}>
            重试组件状态
          </button>
        </div>
      )}
      <div className="settings-catalog">
        {entries.map((entry) => {
          const job = entry.tool ? latest(entry.tool) : undefined;
          const running = job?.status === 'running' || (local.starting === entry.tool && !!entry.tool);
          const ready = entry.tool
            ? localComponentReady(entry.tool, local.info)
            : !!entry.catalog && installed.has(`${entry.catalog.kind}:${entry.catalog.id}`);
          const status = running
            ? '正在安装'
            : ready
              ? '已安装'
              : job?.status === 'failed'
                ? '安装失败'
                : job?.status === 'interrupted'
                  ? '安装中断'
                  : entry.tool && !local.info
                    ? '状态未读取'
                    : undefined;
          const disabled = entry.tool
            ? !!running || !!local.starting || !!local.removing || !local.info || !!local.error || ready
            : !!busy || ready;
          return (
            <SettingsRow
              key={entry.id}
              title={entry.title}
              description={entry.description}
              status={status}
              tone={ready ? 'live' : job?.status === 'failed' ? 'danger' : status ? 'warning' : undefined}
              control={
                !ready && (
                  <button
                    type="button"
                    className="button secondary tiny"
                    aria-label={`安装 ${entry.title}`}
                    disabled={disabled}
                    onClick={() =>
                      entry.tool ? void local.start(entry.tool) : entry.catalog && onInstall(entry.catalog)
                    }
                  >
                    {running ? <Loader2 size={12} className="spinning" /> : entry.tool ? <Download size={12} /> : null}
                    {running
                      ? '后台安装中'
                      : job?.status === 'failed' || job?.status === 'interrupted'
                        ? '重试安装'
                        : '安装'}
                  </button>
                )
              }
            >
              <p>{entry.description}</p>
              {entry.footprint && <p>{entry.footprint}</p>}
              {entry.detail && <p>{entry.detail}</p>}
              <a href={entry.source} target="_blank" rel="noreferrer">
                {entry.sourceLabel}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
              {entry.tool && ready && (
                <button
                  type="button"
                  className="button quiet tiny"
                  disabled={!!running || !!local.starting || !!local.removing || !!local.error}
                  onClick={() => void local.remove(entry)}
                >
                  卸载…
                </button>
              )}
              {job && !ready && job.status !== 'completed' && (
                <div className="extension-installation-note" role="status">
                  {job.message || (running ? '安装正在后台进行，可离开此页。' : '可重新尝试安装。')}
                </div>
              )}
            </SettingsRow>
          );
        })}
      </div>
    </div>
  );
}
