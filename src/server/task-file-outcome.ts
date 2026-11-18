import { trackBusy } from './backend-activity.ts';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RunInput, RunRecord } from '../shared/types.ts';
import { actionText, inspectActionIntent } from './one-for-all-policy.ts';
import type { OrganizeReceipt } from './file-manager.ts';
import { commandCheck, normalizedCommand } from './command-check.ts';
import { redactToolDiagnostic } from './tool-diagnostics.ts';
import { preexistingCheckFailure } from './check-baseline.ts';
import { splitCommandLine } from './command-line.ts';

function isValidationCommand(command: string): boolean {
  const check = /^(?:tests?|build|format|type-?check|lint|tsc|eslint|pytest|vitest|jest)(?:$|[.:-])/i;
  // Split shell operators outside quoted arguments, then inspect the executable and its script, not search terms.
  const parts = command.match(/"[^"]*"|'[^']*'|&&|\|\||[;&|\n]|[^\s;&|]+/g) ?? [];
  const segments: string[][] = [[]];
  for (const part of parts) {
    if (/^(?:&&|\|\||[;&|\n])$/.test(part)) segments.push([]);
    else segments.at(-1)!.push(part);
  }
  return segments.some((segment) => {
    const [raw = '', ...args] = splitCommandLine(segment.join(' '));
    const executable = raw
      .replace(/^.*[/\\]/, '')
      .replace(/\.(?:exe|cmd|bat)$/i, '')
      .toLowerCase();
    if (check.test(executable)) return true;
    if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'dotnet', 'make'].includes(executable)) {
      const positional: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!arg.startsWith('-')) positional.push(arg);
        else if (
          /^(?:--(?:prefix|cwd|dir|workspace|filter|registry|userconfig|cache|loglevel|log-level|config|package)|-[CwFcp])$/.test(
            arg,
          )
        )
          i++;
      }
      return check.test(
        positional[0] === 'run' || positional[0] === 'exec' ? (positional[1] ?? '') : (positional[0] ?? ''),
      );
    }
    if (executable === 'node') return args.some((arg) => arg === '--test' || check.test(arg.replace(/^.*[/\\]/, '')));
    return (executable === 'python' || executable === 'python3') && args[0] === '-m' && args[1] === 'pytest';
  });
}

export const readonlyFileSummary = '这次是只读，没有改文件；要改请切到可写入再发"继续"';

export function mergeFileOutcome(run: RunRecord, outcome: NonNullable<RunRecord['taskOutcome']>) {
  const reported = run.taskOutcome;
  if (['blocked', 'partial', 'failed'].includes(reported?.status ?? ''))
    return { ...reported!, ...(outcome.limitedChecks ? { limitedChecks: outcome.limitedChecks } : {}) };
  return { ...reported, ...outcome };
}

const row = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export function fileChangePaths(data: Record<string, unknown>): string[] {
  const input = row(data.input);
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const fromChanges = changes.flatMap((change) => {
    const item = row(change);
    return typeof item.path === 'string' ? [item.path] : [];
  });
  return [
    ...new Set([
      ...fromChanges,
      ...[input.file_path, input.path, input.filePath].filter((value): value is string => typeof value === 'string'),
    ]),
  ];
}

export function requestsFileChanges(text: string, explicitWrite = false): boolean {
  text = actionText(text);
  if (explicitWrite)
    text = text
      .split(/[，,;；\n]+/u)
      .filter(
        (part) =>
          !/^(?:\s*(?:但|不过|but\b|and\b)\s*)?(?:不要|别|禁止|不改|do not\b|don't\b|never\b)/iu.test(part.trim()),
      )
      .join('; ');
  // An explicit grant preserves the action request alongside a scope restriction. Inspect each clause
  // for positive action evidence; the restriction still reaches the executor in the prompt.
  const requestedAction = explicitWrite
    ? text
        .split(/(?:[。！？!?;；\n]+|\.(?:\s+|$))/u)
        .filter((part) => !inspectActionIntent(part).prohibitsWrite)
        .join('; ')
    : text;
  const intent = inspectActionIntent(requestedAction);
  const checking =
    /^(?:(?:请|请你|帮我|先)\s*)?(?:检查|查看|查找|核对|复核|分析|解释|说明|比较|如何|怎么|是否)|^(?:please\s+)?(?:check|inspect|review|analy[sz]e|explain|describe|compare|how|what|why)\b/iu.test(
      text.trim(),
    );
  return (
    !intent.prohibitsWrite &&
    (intent.explicitAction ||
      (!checking &&
        (/^(?:please\s+)?(?:save|dedupe|deduplicate)\b/i.test(text) ||
          /(?:文件|文件夹|目录).{0,50}(?:分类|整理|去重)|(?:分类|整理|去重).{0,50}(?:文件|文件夹|目录)/u.test(text) ||
          /(?:把|将).{0,100}(?:移动|移到|改成|写入)|(?:实际|直接|倒是)(?:修改|移动|写入)|(?:^|[。；\n])\s*(?:在.{0,100}(?:中|里))?(?:修改|移动|写入|整理|保存)/u.test(
            text,
          )))) &&
    /(?:文件|目录|文件夹|代码|写入|保存|移动|搬移|重命名|去重|修复|重构|实现|\b(?:files?|folders?|directories|code|save|move|rename|dedupe|deduplicate|fix|refactor|implement|edit|modify|update)\b|\.[a-z]{1,5}\b)/iu.test(
      text,
    )
  );
}

/** Only operation records, host snapshots and host verification confirm results; model claims never do. */
export async function confirmFileOutcome(
  run: RunRecord,
  files = claimedFiles(run),
): Promise<NonNullable<RunRecord['taskOutcome']>> {
  const end = trackBusy('task-outcome-confirmation');
  try {
    const outcome = await confirmFileOutcomeImpl(run, files);
    if (
      run.events.some((event) => {
        const check = event.type === 'tool' && commandCheck(event.data ?? {});
        return check && check.failed && preexistingCheckFailure(run.checkBaselines, check.command, check.output);
      })
    )
      outcome.summary = `${outcome.summary ?? ''} check already failed before this task.`;
    return outcome;
  } finally {
    end();
  }
}

/** Only explicit file paths in an executor report make a claim a file contract. */
export function claimedFiles(run: RunRecord): string[] {
  return ['executor-report', 'executor-tool'].includes(run.taskOutcome?.source ?? '')
    ? (run.taskOutcome?.claims ?? []).flatMap((claim) => claim.files ?? [])
    : [];
}

/** Keep heuristic evidence informational; the executor's own blocked/partial report still applies. */
export async function applyFileOutcome(
  run: RunRecord,
  input: Pick<RunInput, 'requiresFileChanges' | 'checkFileChanges' | 'deferFileOutcome'>,
  files = claimedFiles(run),
) {
  if (run.taskOutcome?.status === 'dropped') {
    run.fileChangeNotice = false;
    return;
  }
  if (input.checkFileChanges === false && !input.requiresFileChanges) return;
  const required = input.requiresFileChanges || files.length > 0;
  if (!required && !input.checkFileChanges && !claimsFileChanges(run)) return;
  const outcome = await confirmFileOutcome(run, files);
  run.fileChangeNotice = (!required || !!input.deferFileOutcome) && outcome.status !== 'completed';
  if (input.deferFileOutcome) {
    // Keep the executor's conclusion intact until workflow-wide evidence is available.
    if (outcome.status === 'completed' && (!run.taskOutcome || run.taskOutcome.source === 'missing-report'))
      run.taskOutcome = mergeFileOutcome(run, outcome);
    if (outcome.limitedChecks && run.taskOutcome)
      run.taskOutcome = { ...run.taskOutcome, limitedChecks: outcome.limitedChecks };
    return;
  }
  if (required || outcome.status === 'completed') run.taskOutcome = mergeFileOutcome(run, outcome);
}

async function confirmFileOutcomeImpl(run: RunRecord, files: string[]): Promise<NonNullable<RunRecord['taskOutcome']>> {
  const pathKey = (path: string) => {
    const absolute = resolve(run.projectPath, path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const measured = run.measuredFileChanges?.source === 'pugport-scope-snapshot' ? run.measuredFileChanges.paths : [];
  const commits =
    run.measuredFileChanges?.source === 'pugport-scope-snapshot' ? run.measuredFileChanges.commits : undefined;
  const advanced = !!commits && commits.before !== commits.after;
  const commitSummary = advanced ? `（含提交 ${commits.after.slice(0, 7)}）` : '';
  const insideProject = (path: string) => {
    const within = relative(run.projectPath, path);
    return within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within);
  };
  const measuredKeys = new Set(measured.map(pathKey).filter(insideProject));
  const confirmed = new Set(measuredKeys);
  const started = Date.parse(run.startedAt);
  const ended = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const root = await realpath(run.projectPath).catch(() => undefined);
  // Probe only claimed files; never enumerate ignored dependency or worktree directories.
  for (const file of files.slice(0, 1200)) {
    const path = pathKey(file);
    const local = relative(run.projectPath, path).replace(/\\/g, '/');
    if (
      !root ||
      !insideProject(path) ||
      /(?:^|\/)(?:node_modules|\.git|dist|\.runtime)(?:\/|$)|(?:^|\/)\.(?:claude|codex)\/worktrees(?:\/|$)/i.test(local)
    )
      continue;
    const physical = await realpath(path).catch(() => undefined);
    if (!physical) continue;
    const within = relative(root, physical);
    if (within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) continue;
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile() && Number.isFinite(started) && info.mtimeMs >= started && Math.floor(info.mtimeMs) <= ended)
      confirmed.add(path);
  }
  const state = async (path: string) =>
    lstat(resolve(run.projectPath, path)).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? false : undefined),
    );
  const unknown = (summary: string): NonNullable<RunRecord['taskOutcome']> => ({
    status: 'unverified',
    source: 'file-receipts',
    summary,
  });
  if (run.auditEventsMissing && !advanced && ![...confirmed].some(insideProject))
    return unknown('文件操作记录存在捕获缺口，请先核对已有结果。');
  let unsettled = false;
  let failureNote = '';
  const fileAttempts: Array<{ index: number; paths: string[]; failed: boolean }> = [];
  // Without a host measurement, command failures still gate the limited-check upgrade.
  let unresolvedCommand = false;
  let failedCheck = false;
  const failedCommands: string[] = [];
  const limitedChecks: NonNullable<NonNullable<RunRecord['taskOutcome']>['limitedChecks']> = [];
  let incomplete: NonNullable<RunRecord['taskOutcome']> | undefined;
  const tools = new Map<string, (typeof run.events)[number]>();
  for (const event of run.events) {
    const data = event.data ?? {};
    const id = data.toolCallId ?? data.itemId;
    if (event.type !== 'tool') continue;
    if (typeof id !== 'string') continue;
    const key = `${data.hostAudit === true ? 'host' : 'native'}:${id}`;
    const previous = tools.get(key);
    tools.delete(key); // Iterate by last observation, including interleaved command completions.
    tools.set(key, { ...event, data: { ...previous?.data, ...data } });
  }
  const succeededLater = new Set<string>();
  if (run.verification?.status === 'passed' && run.verification.exitCode === 0)
    succeededLater.add(normalizedCommand(run.verification.command));
  for (const event of [...tools.values()].reverse()) {
    const data = event.data ?? {};
    const check = commandCheck(data);
    if (!check) continue;
    if (check.failed && preexistingCheckFailure(run.checkBaselines, check.command, check.output)) continue;
    if (check.succeeded) {
      if (check.key) succeededLater.add(check.key);
    } else if (!check.failed || !check.key || !succeededLater.has(check.key)) {
      if (check.limited)
        limitedChecks.unshift({
          id: String(data.toolCallId ?? data.itemId),
          command: check.command || String(data.nativeTool ?? data.tool ?? data.kind),
          reason: check.reason,
        });
      else {
        unresolvedCommand = true;
        if (isValidationCommand(check.command)) {
          failedCheck = true;
          if (check.command && !failedCommands.includes(check.command)) failedCommands.unshift(check.command);
        }
      }
    }
  }
  for (const event of tools.values()) {
    const data = event.data ?? {};
    if (
      data.hostAudit === true &&
      data.kind === 'pugportToolCall' &&
      ['organize_files', 'recycle_files'].includes(String(data.tool))
    ) {
      const receipt = row(row(data.result).structuredContent) as Partial<OrganizeReceipt>;
      if (!receipt.operationIds?.length) {
        unsettled = true;
        continue;
      }
      for (const move of receipt.moves ?? []) {
        if ((await state(move.from)) !== false || (await state(move.to)) !== true)
          return unknown('整理回执与当前源文件或目标状态不一致，请先核对已有结果。');
        confirmed.add(pathKey(move.to));
      }
      for (const path of receipt.recycled ?? []) {
        if ((await state(path)) !== false) return unknown('回收回执与当前文件状态不一致，请先核对已有结果。');
        confirmed.add(pathKey(path));
      }
      if (receipt.status !== 'completed' || receipt.failed)
        incomplete ??= {
          status: receipt.succeeded ? 'partial' : 'blocked',
          source: 'file-receipts',
          summary: `整理请求 ${receipt.requested ?? 0} 项，成功 ${receipt.succeeded ?? 0} 项，失败 ${receipt.failed ?? 0} 项，跳过 ${receipt.skipped ?? 0} 项；已完成的操作不得重复执行。`,
        };
    }
    const editTool =
      data.hostAudit !== true &&
      (data.kind === 'edit' ||
        ['write', 'edit', 'multiedit', 'writefile', 'editfile'].includes(
          String(data.nativeTool ?? data.tool)
            .replace(/[_-]/g, '')
            .toLowerCase(),
        ));
    const input = row(data.input);
    const editPath = input.file_path ?? input.path ?? input.filePath;
    const fileOp = data.hostAudit !== true && (data.kind === 'fileChange' || editTool);
    if (fileOp && (data.status !== 'completed' || data.isError === true)) {
      const paths = fileChangePaths(data).map(pathKey);
      if (paths.length && !paths.some(insideProject)) continue;
      fileAttempts.push({ index: fileAttempts.length, paths: paths.filter(insideProject), failed: true });
      const note =
        typeof data.failureText === 'string' ? data.failureText : typeof data.output === 'string' ? data.output : '';
      if (!failureNote && note) failureNote = redactToolDiagnostic(note, 500);
    }
    if (editTool && data.status === 'completed' && data.isError !== true) {
      const path = editPath;
      if (typeof path === 'string') {
        if (!insideProject(pathKey(path))) continue;
        if ((await state(path)) !== true) {
          if (measuredKeys.has(pathKey(path))) continue;
          return unknown('写入回执与当前目标状态不一致，请先核对已有结果。');
        }
        confirmed.add(pathKey(path));
        fileAttempts.push({ index: fileAttempts.length, paths: [pathKey(path)], failed: false });
      }
    }
    if (data.hostAudit !== true && data.kind === 'fileChange' && data.status === 'completed' && data.isError !== true) {
      const changes = row(data.input).changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const item = row(change);
        if (typeof item.path !== 'string' || !insideProject(pathKey(item.path))) continue;
        const deleted = row(item.kind).type === 'delete';
        if ((await state(item.path)) !== !deleted) {
          if (measuredKeys.has(pathKey(item.path))) continue;
          return unknown('文件修改回执与当前目标状态不一致，请先核对已有结果。');
        }
        confirmed.add(pathKey(item.path));
        fileAttempts.push({ index: fileAttempts.length, paths: [pathKey(item.path)], failed: false });
      }
    }
  }
  const fileUnsettled = fileAttempts.some(
    (attempt) =>
      attempt.failed &&
      (attempt.paths.length === 0 ||
        attempt.paths.some(
          // A failed write is settled by a later successful write to it, or by PugPort's own git measurement.
          (path) =>
            !measuredKeys.has(path) &&
            !fileAttempts.some((later) => later.index > attempt.index && !later.failed && later.paths.includes(path)),
        )),
  );
  if (unsettled || fileUnsettled)
    return unknown(
      failureNote
        ? `存在失败或未确认的文件操作，请先核对已有结果，不得直接重放。 ${failureNote}`
        : '存在失败或未确认的文件操作，请先核对已有结果，不得直接重放。',
    );
  if (incomplete) return incomplete;
  if (failedCheck) {
    // The executor knows why a check failed (a pre-existing failure, a baseline comparison, a red test it was
    // asked to investigate). Its structured completion report stands; the failed commands stay visible.
    const reported =
      run.taskOutcome?.status === 'completed' &&
      (run.taskOutcome.source === 'executor-report' || run.taskOutcome.source === 'executor-tool');
    if (!reported) return unknown('测试、构建或代码检查命令未通过，请先核对已有结果。');
    run.failedChecks = failedCommands.slice(0, 8);
  }
  if (limitedChecks.length && run.verification && run.verification.status !== 'passed') {
    return unknown('验收命令未通过，请先核对已有结果。');
  }
  if (
    files.some(
      (path) => !insideProject(pathKey(path)) || (!advanced && !measuredKeys.size && !confirmed.has(pathKey(path))),
    )
  )
    return unknown('没有可核对的文件操作回执，尚不能确认请求的改动已完成。');
  if (limitedChecks.length) {
    const projectChanges = advanced || [...confirmed].some(insideProject);
    if (
      (unresolvedCommand && !advanced && !measuredKeys.size) ||
      !projectChanges ||
      run.errorCode ||
      run.status === 'cancelled'
    )
      return unknown('检查受限，但没有足够证据确认本轮文件结果。');
    return {
      status: 'completed',
      source: 'file-receipts',
      verificationLimited: true,
      limitedChecks,
      summary: `代码已改完；有 ${limitedChecks.length} 项检查在沙箱里没法运行，请在本机补跑${commitSummary}`,
    };
  }
  if (run.verification?.status === 'passed' && run.verification.exitCode === 0 && run.verification.command.trim())
    return {
      status: 'completed',
      source: 'file-receipts',
      summary: `PugPort 执行的验收命令已通过，已确认请求的文件结果（可能无需改动）。${commitSummary}`,
    };
  return confirmed.size || advanced
    ? {
        status: 'completed',
        source: 'file-receipts',
        summary: run.measuredFileChanges?.commits
          ? `已确认 ${confirmed.size} 项文件变化（操作回执或 PugPort 实测，含提交 ${run.measuredFileChanges.commits.after.slice(0, 7)}）。${run.auditEventsMissing ? '事件记录有缺口。' : ''}`
          : `已确认 ${confirmed.size} 项文件变化（操作回执或 PugPort 实测）。${run.auditEventsMissing ? '事件记录有缺口。' : ''}`,
      }
    : unknown('没有可核对的文件操作回执，尚不能确认请求的改动已完成。');
}

function claimsFileChanges(run: RunRecord): boolean {
  const reportedText = [
    run.output,
    run.taskOutcome?.summary,
    ...(run.taskOutcome?.claims ?? []).flatMap((claim) => [claim.claim, claim.evidence]),
  ]
    .filter(Boolean)
    .join('\n')
    .replace(
      /(?:没有|未曾|未|无需|不需要)(?:进行|做出)?(?:任何)?(?:文件)?(?:修改|改动|写入|删除|新增)|\bno\s+(?:file\s+)?changes\b|\bno\s+files?\s+(?:(?:was|were|have been|has been)\s+)?(?:changed|modified|updated|edited|written|saved|created|deleted|removed|renamed|moved|added)\b/giu,
      '',
    )
    .replace(
      /\b(?:not|never|(?:have|has|had|did|was|were|is|are)n['’]t)\s+(?:changed|modified|updated|edited|written|saved|created|deleted|removed|renamed|moved|added|made\s+(?:file\s+)?changes)\b/giu,
      '',
    );
  return /(?:已(?:经)?|成功(?:地)?|完成(?:了)?)(?:修改|改动|写入|删除|新增|创建|更新|移动|重命名|保存|修复|实现|添加|生成|编写|替换|调整)|(?:修改|改动|写入|删除|新增|创建|更新|移动|重命名|保存)了|(?:^|[。；！？\n])\s*(?:[-*]\s*)?(?:修改|改动|写入|删除|新增|创建|更新|移动|重命名|保存)|\b(?:changed|modified|updated|edited|wrote|written|saved|created|deleted|removed|renamed|moved|implemented|fixed|added|applied|made\s+(?:file\s+)?changes)\b/iu.test(
    reportedText,
  );
}
