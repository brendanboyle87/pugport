import { observedLabel, type QuotaLine, type QuotaTotal } from '../shared/quota-summary.ts';
import type { SystemResources } from './system-monitor.ts';
import { webResetLabel, webTokenLabel } from '../shared/external-agents.ts';
import { shortHardwareName } from '../shared/hardware-name.ts';

export type TrayData = {
  running: number;
  lines: QuotaLine[];
  totals: QuotaTotal[];
  keepAwake?: boolean;
  localRunning?: number;
  localTitle?: string;
  localPhase?: string;
};
const providerNames: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
  gemini: 'Gemini',
  pi: 'API',
};
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const tone = (value?: number) =>
  value === undefined ? '#6B6B70' : value <= 10 ? '#F87171' : value <= 30 ? '#FBBF24' : '#4ADE80';
const resourceTitle = '本机资源';
const openLabel = '打开主界面';

/** "3 天后重置" a day or more out, else hours and minutes. */
const resetLabel = (at: string, now: number) => {
  const days = (Date.parse(at) - now) / 86_400_000;
  return days >= 1 ? `${Math.ceil(days)} 天后重置` : webResetLabel(at, now);
};

const percent = (value?: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;

/** Only the resource section's contents; the tray updates its values without navigating the page. */
export function trayResourcesHtml(resources?: SystemResources): string {
  const cpu = percent(resources?.cpuPercent);
  const gpu = percent(resources?.gpuPercent);
  const memory = resources?.memory;
  const knownMemory =
    memory &&
    Number.isFinite(memory.totalBytes) &&
    memory.totalBytes > 0 &&
    Number.isFinite(memory.usedBytes) &&
    memory.usedBytes >= 0;
  const ram = knownMemory
    ? (percent(memory.percent) ?? percent((memory.usedBytes / memory.totalBytes) * 100))
    : undefined;
  const ramDetail = knownMemory
    ? `${(Math.min(memory.usedBytes, memory.totalBytes) / 1024 ** 3).toFixed(1)} / ${(memory.totalBytes / 1024 ** 3).toFixed(1)} GiB`
    : '—';
  const gpuState = gpu !== undefined ? 'available' : resources?.gpuState === 'unavailable' ? 'unavailable' : 'loading';
  const gpuTitle =
    resources?.gpuState === 'stale' && gpu !== undefined
      ? '保留上次 GPU 读数，正在等待更新。'
      : gpuState === 'unavailable'
        ? '系统暂未提供 GPU 占用，无法读取时不会显示为 0%。'
        : gpuState === 'loading'
          ? '正在读取本机 GPU 占用。'
          : '本机所有 GPU 中最忙引擎的占用。';
  const cpuModel = shortHardwareName(resources?.cpu?.model ?? '');
  const counts = resources?.cpu?.threads
    ? resources.cpu.cores
      ? `${resources.cpu.cores} 核 ${resources.cpu.threads} 线程`
      : `${resources.cpu.threads} 线程`
    : '';
  const cpuDetail = [cpuModel, counts].filter(Boolean).join(' · ') || '读取中';
  const gpuModel = shortHardwareName(resources?.gpu?.name ?? '');
  const vram = resources?.gpuProvider === 'nvidia-smi' ? resources.gpu?.memory : undefined;
  const gpuDetail =
    [gpuModel, vram ? `显存 ${(vram.usedMiB / 1024).toFixed(1)}/${(vram.totalMiB / 1024).toFixed(1)} GB` : '']
      .filter(Boolean)
      .join(' · ') || '—';
  const fullGpu = [resources?.gpu?.name, vram ? gpuDetail : '', ...(resources?.gpu?.others ?? [])]
    .filter(Boolean)
    .join(' · ');
  const items = [
    {
      id: 'cpu',
      name: 'CPU',
      value: cpu,
      detail: cpuDetail,
      model: cpuModel,
      title: [resources?.cpu?.model, cpuDetail, '本机所有处理器的平均占用。'].filter(Boolean).join(' · '),
    },
    {
      id: 'gpu',
      name: 'GPU',
      value: gpu,
      detail:
        resources?.gpuState === 'stale' && gpu !== undefined
          ? '等待更新'
          : gpuState === 'available'
            ? gpuDetail
            : gpuState === 'unavailable'
              ? '暂不可用'
              : '读取中',
      title: [fullGpu, gpuTitle].filter(Boolean).join(' · '),
    },
    { id: 'memory', name: '内存', value: ram, detail: ramDetail, title: [ramDetail, '本机物理内存占用。'].join(' · ') },
  ];
  return `<div class="resource-heading" data-resource-part="drag-region" title="拖动可移动窗口"><strong data-resource-part="heading">${resourceTitle}</strong><span class="drag-grip" aria-hidden="true">⠿</span></div><div class="resources">${items
    .map(
      ({ id, name, value, detail, title, model }) =>
        `<div class="resource" data-resource="${id}" data-resource-part="${id}-cell" title="${escape(title)}"><div class="resource-label"><span data-resource-part="${id}-name">${name}</span><b data-resource-part="${id}-value">${value === undefined ? '—' : `${Math.round(value)}%`}</b></div><div class="resource-bar"><i data-resource-part="${id}-bar" style="width:${value ?? 0}%;opacity:${value === undefined ? 0 : 1}"></i></div><small${id === 'cpu' ? ` data-model="${escape(model ?? '')}" data-full="${escape(detail)}"` : ''} title="${escape(title)}" data-resource-part="${id}-detail">${escape(detail)}</small></div>`,
    )
    .join('')}</div>`;
}

/** The quota card shown above the tray icon; a static page, no scripts or Node access. */
export function trayPopupHtml(data: TrayData, now = Date.now(), resources?: SystemResources): string {
  const totals = data.totals
    .map(
      (total) =>
        `<span class="total${total.stale ? ' stale' : ''}"${total.stale ? ' title="含上次的读数，最新一次检查没有完成"' : ''}><b>${providerNames[total.provider] ?? total.provider}</b> ${total.known ? `${Math.round(total.total * 100)}%` : '—'}</span>`,
    )
    .join('');
  const rows = data.lines
    .map((line) => {
      // Window names read like the rest of the card; only the share left carries the colour.
      const windows = line.windows.length
        ? line.windows
            .map(
              (w) =>
                `<span>${w.name
                  .split(' ')
                  .map((part) => `<span>${escape(part)}</span>`)
                  .join(
                    ' ',
                  )} <b style="color:${tone(w.remaining)}">${w.remaining ?? '—'}${w.remaining === undefined ? '' : '%'}</b></span>`,
            )
            .join('')
        : `<span style="color:#6B6B70">${line.pending ? '正在读取额度…' : '额度未知'}</span>`;
      // Separate pools (Cursor's) get a bar each; any other account one bar (weekly, or 5h when it runs low).
      const shown =
        line.pending || (line.provider === 'web' && !line.windows.length)
          ? []
          : line.bars?.length
            ? line.bars
            : [line.tightest];
      const bars = shown
        .map((left) => `<div class="bar"><i style="width:${left ?? 0}%;background:${tone(left)}"></i></div>`)
        .join('');
      // One label per bar: each pool's name starts where its own bar starts.
      const split = shown.length > 1 && line.windows.length === shown.length;
      const columns = split ? ` split" style="grid-template-columns:repeat(${shown.length},minmax(0,1fr))` : '';
      // A used-up account says when it comes back, like the app's usage cards: the last of its empty windows.
      const back = line.pending
        ? undefined
        : line.windows
            .filter((w) => w.remaining === 0 && Number.isFinite(Date.parse(w.resetsAt ?? '')))
            .map((w) => w.resetsAt!)
            .sort()
            .at(-1);
      const detail = [line.detail, back ? resetLabel(back, now) : ''].filter(Boolean).join(' · ');
      const balances = (line.balances ?? [])
        .map(
          (balance) =>
            `<div class="windows${balance.stale ? ' reference' : ''}"><span>${escape(balance.label)} · ${balance.stale ? '上次读数 · ' : ''}已使用 ${balance.usedPercent}% · 剩余 ${escape(webTokenLabel(balance.remainingTokens))} · 从不过期</span></div>`,
        )
        .join('');
      return `<div class="row${line.reference ? ' reference' : ''}${line.provider === 'web' ? ' web' : ''}"><div class="line"><span class="name" title="${escape(line.label)}">${escape(line.label)}</span><time>${line.reference ? '上次读数 · ' : ''}${line.pending ? '' : observedLabel(line.observedAt, now)}</time></div>${line.windows.length || !line.balances?.length ? `<div class="windows${columns}">${windows}</div>` : ''}<div class="bars">${bars}</div>${detail ? `<small>${escape(detail)}</small>` : ''}${balances}</div>`;
    })
    .join('');
  const statuses = [
    ...(data.running
      ? [`<span class="live"><i></i><span class="live-label">${data.running} 个 Agent 任务运行中</span></span>`]
      : []),
    ...(data.localRunning
      ? [
          `<span class="live local" title="${escape(data.localTitle || '本地任务处理中')}"><i></i><span class="live-label">${escape(data.localTitle || '本地任务处理中')}</span></span>`,
        ]
      : []),
  ];
  const status = statuses.length
    ? `<div class="activity">${statuses.join('')}</div>`
    : '<span class="idle">空闲</span>';
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;overflow:hidden;background:transparent;font:12px/1.4 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;color:#EDEDEF;-webkit-user-select:none;user-select:none}
.card{display:flex;flex-direction:column;max-height:calc(100vh - 12px);margin:6px;padding:12px 14px;background:#111113;border:1px solid #26262A;border-radius:12px}
#system-resources{flex-shrink:0;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #26262A}
#quota-content{min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#3F3F46 transparent;scrollbar-gutter:stable}
.resource-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.resource-heading strong{font-size:13px;font-weight:600;letter-spacing:.2px}
.resource-heading,header{-webkit-app-region:drag;app-region:drag;cursor:move}.drag-grip{font-size:16px;line-height:1;color:#6B6B70}a{-webkit-app-region:no-drag;app-region:no-drag}
.resources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.resource{min-width:0}.resource-label{display:flex;align-items:center;justify-content:space-between;gap:4px;white-space:nowrap;font-size:11px;color:#AAAAB2}
.resource-label b{font-size:12px;font-weight:600;color:#EDEDEF;min-width:30px;text-align:right;font-variant-numeric:tabular-nums}
.resource-bar{height:3px;margin-top:6px;background:#26262A;border-radius:3px;overflow:hidden}
.resource-bar i{display:block;height:100%;border-radius:3px;background:#60A5FA;transition:width 250ms ease,opacity 250ms ease}
[data-resource="gpu"] .resource-bar i{background:#A78BFA}[data-resource="memory"] .resource-bar i{background:#5EEAD4}
.resource small{display:block;min-height:14px;margin-top:5px;font-size:10px;line-height:14px;color:#8B8B92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
header strong{font-size:13px;font-weight:600;letter-spacing:.2px;flex-shrink:0}
.activity{display:flex;flex-direction:column;align-items:flex-end;min-width:0;max-width:calc(100% - 70px)}.live,.idle{font-size:11px;color:#8B8B92;display:inline-flex;align-items:center;gap:6px}.live{max-width:100%;overflow:hidden;white-space:nowrap}.live-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.live i{width:6px;height:6px;border-radius:50%;background:#22C55E;animation:b 1.2s ease-in-out infinite}
.live.local i{background:#60A5FA}.live i{flex-shrink:0}.local-phase{font-size:10px;color:#8B8B92;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin:-4px 0 8px}
@keyframes b{50%{opacity:.25}}
.totals{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.total{padding:3px 8px;border:1px solid #26262A;border-radius:999px;font-size:11px;color:#C9C9CE;font-variant-numeric:tabular-nums}
.total b{font-weight:600;color:#EDEDEF}.total small{color:#6B6B70}.total.stale{color:#6B6B70}
.row{padding:3px 0;border-top:1px solid #1E1E22}.row:first-child{border-top:0}
.line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:baseline}
.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.windows{display:flex;flex-wrap:wrap;gap:3px 8px;margin-top:2px;font-size:10.5px;line-height:1.3;font-variant-numeric:tabular-nums}
.windows>span{max-width:100%;overflow-wrap:anywhere;color:#8E8E93}.windows b{font-weight:500}
.windows.split{display:grid;gap:3px 4px}
.reference .windows b{opacity:.6}
.row.web.reference .windows,.row.web.reference .bars,.windows.reference{opacity:.55}
time{font-size:11px;color:#6B6B70;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.bars{display:flex;gap:4px;margin-top:3px}
.bar{flex:1;height:2px;background:#1E1E22;border-radius:2px;overflow:hidden}.bar i{display:block;height:100%}
footer{display:flex;flex-shrink:0;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px solid #1E1E22;font-size:11px;color:#6B6B70}
a{color:#C9C9CE;text-decoration:none}a:hover{color:#FFFFFF}
.empty{color:#6B6B70;padding:6px 0}
@media(prefers-reduced-motion:reduce){.resource-bar i{transition:none}.live i{animation:none}}
</style><body><div class="card">
<section id="system-resources" aria-label="${resourceTitle}">${trayResourcesHtml(resources)}</section>
<div id="quota-content">
<header><strong>剩余额度</strong>${status}</header>
${data.localRunning && data.localPhase ? `<div class="local-phase" title="${escape(data.localPhase)}">${escape(data.localPhase)}</div>` : ''}
${totals ? `<div class="totals" title="每个账号按最紧的额度窗口计，一个账号满额是 100%，多个账号相加">${totals}</div>` : ''}
${rows || '<div class="empty">还没有可读取额度的执行器。</div>'}
</div><footer id="tray-actions"><a href="combo://refresh">刷新额度</a><a href="combo://open">${openLabel}</a></footer>
</div></body></html>`;
}
