import { randomBytes } from 'node:crypto';
import { parseVerdict } from '../judge-config.ts';
import { noToollessExecutor } from '../routing.ts';
import { settledStatuses } from '../node/peer-protocol.ts';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import { JudgeUnavailableError, type NoToolsRunner } from './executor.ts';
import { materialLimits, type PrMaterial, type BlockedMaterial } from './pr-material.ts';
import type { TierResult } from './tiers.ts';
import { clampSection } from './outbound.ts';
import { defaultPrJudgeTemplate, renderPrJudgePrompt } from './pr-judge-prompt.ts';

export type PrJudgeOutcome = {
  verdict: 'pass' | 'fail' | 'blocked' | 'invalid';
  firstLine: string;
  sections: { risks: string; tests: string; missing: string };
  signature?: string;
  text: string;
  judgeId: string;
  executor?: string;
  model?: string;
  promptBytes: number;
  omitted: string[];
  startedAt: string;
  endedAt: string;
  sha?: string;
};
type JudgeInput = {
  material: PrMaterial | BlockedMaterial;
  tier: TierResult;
  trusted: boolean;
  mode?: 'shadow' | 'live';
  /** A smaller prompt budget for a judge model with a small context window; defaults to materialLimits. */
  maxPromptBytes?: number;
};
export function buildPrJudgePrompt(input: JudgeInput): { prompt: string; omitted: string[]; blocked?: string } {
  if ('blocked' in input.material) return { prompt: '', omitted: [], blocked: input.material.blocked };
  const omitted: string[] = [];
  const clean = (text: string) => text.replace(/UNTRUSTED-/gi, 'UNTRUSTED_');
  const original = input.material;
  const m = {
    ...original,
    title: clean(original.title),
    body: clean(original.body),
    diff: clean(original.diff),
    files: original.files.map((f) => ({
      ...f,
      path: clean(f.path),
      previousPath: f.previousPath === undefined ? undefined : clean(f.previousPath),
      baseText: f.baseText === undefined ? undefined : clean(f.baseText),
    })),
    relatedTests: original.relatedTests.map((f) => ({
      path: clean(f.path),
      text: clean(f.text),
    })),
  };
  omitted.push(
    ...original.omitted.map(clean),
    ...m.files.filter((f) => f.baseOmitted).map((f) => f.path + ': ' + f.baseOmitted),
  );
  if (
    m.changedFiles > materialLimits.maxChangedFiles ||
    m.additions + m.deletions > materialLimits.maxChangedLines ||
    Buffer.byteLength(original.diff) > materialLimits.maxDiffBytes
  )
    return { prompt: '', omitted, blocked: 'too large for a no-tools review' };
  let body = m.body;
  if (Buffer.byteLength(body) > materialLimits.maxBodyBytes) {
    body = Buffer.from(body)
      .subarray(0, materialLimits.maxBodyBytes)
      .toString('utf8')
      .replace(/\uFFFD$/, '');
    omitted.push('BODY: truncated to 20000 bytes');
  }
  const base = m.files.filter((f) => f.baseText !== undefined).map((f) => ({ path: f.path, text: f.baseText! }));
  const tests = [...m.relatedTests];
  const maxPromptBytes = input.maxPromptBytes ?? materialLimits.maxPromptBytes;
  const tag = randomBytes(16).toString('hex');
  const fence = (name: string, text: string) => `BEGIN-UNTRUSTED-${tag} ${name}\n${text}\nEND-UNTRUSTED-${tag}`;
  const render = () =>
    renderPrJudgePrompt(defaultPrJudgeTemplate, {
      repository: m.repository,
      number: String(m.number),
      sha: m.headSha,
      base: m.baseSha,
      tier: input.tier.tier,
      trust: input.trusted ? 'collaborator' : 'external',
      materials: [
        fence('TITLE', m.title),
        fence('BODY', body),
        fence(
          'FILES',
          m.files
            .map(
              (f) =>
                `${JSON.stringify(f.path)}${f.previousPath ? ` (from ${JSON.stringify(f.previousPath)})` : ''} ${f.status} +${f.additions}/-${f.deletions}${f.baseOmitted ? ` base omitted: ${f.baseOmitted}` : ''}`,
            )
            .join('\n'),
        ),
        fence('DIFF', m.diff),
        ...base.map((f) => fence('BASE FILE', `${JSON.stringify(f.path)}\n${f.text}`)),
        ...tests.map((f) => fence('RELATED TEST', `${JSON.stringify(f.path)}\n${f.text}`)),
        fence('OMITTED FOR SIZE OR UNAVAILABLE', omitted.join('\n') || 'nothing'),
      ].join('\n\n'),
    });
  let prompt = render();
  for (const collection of [tests, base]) {
    collection.sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text));
    while (Buffer.byteLength(prompt) > maxPromptBytes && collection.length) {
      const dropped = collection.shift()!;
      omitted.push(`${collection === tests ? 'RELATED TEST' : 'BASE FILE'} ${dropped.path}: budget`);
      prompt = render();
    }
  }
  return {
    prompt,
    omitted,
    ...(Buffer.byteLength(prompt) > maxPromptBytes
      ? {
          blocked: `too large for a no-tools review: prompt exceeds ${Math.floor(maxPromptBytes / 1000)} kB after omitting context`,
        }
      : {}),
  };
}
export async function runPrJudge(
  input: JudgeInput,
  deps: { runner: NoToolsRunner; now?: () => number; timeoutMs?: number; signal?: AbortSignal },
): Promise<PrJudgeOutcome> {
  const now = deps.now ?? Date.now;
  const start = now();
  const startedAt = new Date(start).toISOString();
  const judgeId = `pj-${startedAt.slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`;
  const outcome: PrJudgeOutcome = {
    verdict: 'blocked',
    firstLine: '',
    sections: { risks: '', tests: '', missing: '' },
    text: '',
    judgeId,
    promptBytes: 0,
    omitted: [],
    startedAt,
    endedAt: startedAt,
    ...('headSha' in input.material ? { sha: input.material.headSha } : {}),
  };
  const blocked = (reason: string) => ({
    ...outcome,
    text: reason,
    sections: { ...outcome.sections, missing: reason },
    endedAt: new Date(now()).toISOString(),
  });
  let taskId: string | undefined;
  const abort = new AbortController();
  const timeout = deps.timeoutMs ?? 20 * 60_000;
  const timer = setTimeout(() => abort.abort(new Error('judge timed out')), timeout);
  const onAbort = () => abort.abort(new Error('judge cancelled'));
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  if (deps.signal?.aborted) onAbort();
  try {
    const built = buildPrJudgePrompt(input);
    outcome.omitted = built.omitted;
    outcome.promptBytes = Buffer.byteLength(built.prompt);
    if (built.blocked) return blocked(built.blocked);
    const deadline = () => {
      if (now() - start >= timeout) abort.abort(new Error('judge timed out'));
      abort.signal.throwIfAborted();
    };
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      deadline();
      let stop!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        stop = () => reject(abort.signal.reason);
        abort.signal.addEventListener('abort', stop, { once: true });
      });
      try {
        return await Promise.race([promise, cancelled]);
      } finally {
        abort.signal.removeEventListener('abort', stop);
      }
    };
    deadline();
    const dispatch = deps.runner.dispatch({
      prompt: built.prompt,
      title: `GitHub maintenance${input.mode === 'shadow' ? ' · shadow' : ''} · PR #${'number' in input.material ? input.material.number : ''}`,
    });
    void dispatch.then(
      (run) => {
        if (abort.signal.aborted) void deps.runner.cancel(run.taskId).catch(() => {});
      },
      () => {},
    );
    const run = await wait(dispatch);
    taskId = run.taskId;
    for (;;) {
      deadline();
      const result = await wait(deps.runner.result(taskId, 50, abort.signal));
      deadline();
      if (!settledStatuses.has(result.status)) continue;
      if (result.status !== 'completed')
        throw new Error(result.error === noToollessExecutor ? 'noToollessExecutor' : result.error || result.status);
      const text = result.result ?? '';
      const parsed = parseVerdict(text, outcome.sha!);
      if (!/^(PASS|FAIL|BLOCKED)\s*@\s*[0-9a-fA-F]{7,40}\s*$/.test(parsed.firstLine)) parsed.verdict = 'invalid';
      for (const name of ['Risks', 'Tests', 'Missing'] as const) {
        const section =
          new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |^JUDGE:|(?![\\s\\S]))`, 'm').exec(text)?.[1]?.trim() ??
          '';
        outcome.sections[name.toLowerCase() as keyof typeof outcome.sections] = clampSection(section, 1500);
      }
      return {
        ...outcome,
        ...parsed,
        text,
        executor: result.executor,
        model: result.model,
        endedAt: new Date(now()).toISOString(),
      };
    }
  } catch (error) {
    if (taskId) await deps.runner.cancel(taskId).catch(() => {});
    // A pinned judge that cannot run gives no verdict at all; the caller keeps the review queued.
    if (error instanceof JudgeUnavailableError) throw error;
    return blocked(`judge could not run: ${redactToolDiagnostic(String(error), 400)}`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}
