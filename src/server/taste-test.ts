import { randomUUID } from 'node:crypto';
import type {
  Conversation,
  ConversationRouting,
  ConversationRoutingData,
  RoutingRule,
  Project,
  Provider,
  RunRecord,
  TasteCandidate,
  TasteTest,
  WritingPreference,
  WritingTopic,
} from '../shared/types.ts';
import { upgradeRouting } from '../shared/conversation-routing.ts';
import { effortOrder, parseCursorModel } from '../shared/model-family.ts';
import { replayModelSelection } from '../shared/execution-model.ts';
import { writingRequest } from '../shared/fiction.ts';
import type { Controller } from './controller.ts';
import { matureContent } from './routing.ts';
import type { WorkspaceStore } from './workspace-store.ts';

/*
 * Taste tests. When the conversation's rules leave the writer open and the project has no preference yet, three
 * candidates (different models, or one model at different efforts) each write the same short passage. The user
 * picks one without knowing who wrote it; the pick and the reason become the project's writing preference, which
 * routing then fills in wherever the rules leave the choice open.
 */

const keys = ['A', 'B', 'C'] as const;
/**
 * Platforms tried for ordinary prose, and for adult material (which the others refuse). Cursor comes after the
 * platforms whose makers it would duplicate, so it can bring a model from another maker.
 */
const platforms: Record<WritingTopic, Provider[]> = {
  prose: ['claude', 'grok', 'cursor', 'codex'],
  adult: ['grok', 'cursor'],
};
/** Makers whose models Cursor may bring, in the order tried; adult material stays with Grok. */
const cursorMakers: Record<WritingTopic, string[]> = {
  prose: ['gpt', 'gemini', 'kimi', 'claude', 'grok', 'glm'],
  adult: ['grok'],
};
const settled: RunRecord['status'][] = ['completed', 'failed', 'cancelled', 'interrupted'];
/** A sample that takes longer than this is stopped; the others can still be compared. */
const sampleLimitMs = 15 * 60_000;
/** Automatic tests for one project and kind of writing start at most once a day. */
const autoSpacingMs = 24 * 3_600_000;

export { writingRequest } from '../shared/fiction.ts';

/** Drops a sentence of preamble ("我先看看文稿，再写一段") before the passage, which would give its writer away. */
export function samplePassage(output: string): string {
  let text = output.trim();
  for (let i = 0; i < 3; i++) {
    const preamble =
      /^(?:好的|好，|下面是|以下是|我先|我会先|我将|先看|根据(?:你|您|项目))[^\n]{0,150}?[。：:！]\s*/.exec(text);
    if (!preamble || preamble[0].length >= text.length) break;
    text = text.slice(preamble[0].length).trimStart();
  }
  return text;
}

export const writingTopic = (text: string): WritingTopic => (matureContent(text) ? 'adult' : 'prose');

/** The routing topic a writing preference fills in. */
const ruleTopic = (topic: WritingTopic) => (topic === 'adult' ? 'adult' : 'writing');

/** A project preference fills only an absent category; an explicit clear is also the user's choice. */
export function openTopic(routing: ConversationRoutingData | undefined, topic: WritingTopic): boolean {
  return !routing || !upgradeRouting(routing).rules.some((rule) => rule.category === ruleTopic(topic));
}

/**
 * The conversation's rules with the project's writing preferences filled in where they leave the choice open.
 * Without rules of its own, a conversation gets them only for a writing request.
 */
export function withPreferences(
  data: ConversationRoutingData | undefined,
  preferences: WritingPreference[] | undefined,
  writing: boolean,
): ConversationRouting | undefined {
  const routing = data ? upgradeRouting(data) : undefined;
  if (!preferences?.length || (!routing && !writing)) return routing;
  const rules = [...(routing?.rules ?? [])];
  for (const preference of preferences) {
    if (!openTopic(routing, preference.topic)) continue;
    const topic = ruleTopic(preference.topic);
    // Keep Cursor's replayable slug: stripping it to a family discards confirmed thinking/fast flags.
    const cursor = preference.provider === 'cursor' ? parseCursorModel(preference.model) : undefined;
    const rule: RoutingRule = {
      id: `taste:${topic}`,
      category: topic,
      enabled: true,
      source: 'manual',
      strict: topic === 'adult',
      candidates: [
        {
          provider: preference.provider,
          model: preference.model,
          ...((cursor?.effort ?? preference.effort) ? { effort: cursor?.effort ?? preference.effort } : {}),
        },
      ],
    };
    rules.push(rule);
  }
  return {
    ...(routing ?? { version: 2, text: '', unparsed: [], chapterAgents: false, mask: false, updatedAt: '' }),
    rules,
  };
}

/** What the user said about the passages they picked, for every task that writes in this project. */
export function preferenceNotes(preferences: WritingPreference[] | undefined): string {
  const notes = (preferences ?? []).filter((preference) => preference.reason?.trim());
  if (!notes.length) return '';
  return `用户在试写对比里说过的写作偏好（写作时照此执行）：\n${notes
    .map((preference) => `- ${preference.topic === 'adult' ? '成人内容' : '正文'}：${preference.reason!.trim()}`)
    .join('\n')}`;
}

const pairKey = (candidate: { provider: Provider; model: string }) =>
  `${candidate.provider}/${candidate.provider === 'cursor' ? parseCursorModel(candidate.model).family : candidate.model}`;
const variantKey = (candidate: { provider: Provider; model: string; effort?: string }) =>
  `${candidate.provider}/${candidate.model}/${candidate.effort ?? ''}`;
/** Who makes a model: Codex runs GPT, and Cursor's ids start with the maker ("gemini-3.1-pro", "cursor-grok-4.6"). */
function makerOf(candidate: { provider: Provider; model: string }): string {
  if (candidate.provider !== 'cursor') return candidate.provider === 'codex' ? 'gpt' : candidate.provider;
  const family = parseCursorModel(candidate.model).family;
  return /grok/.test(family) ? 'grok' : family.split(/[-.]/)[0]!;
}
/** A model family's version numbers ("gpt-5.6-sol" → [5, 6]); the newest sorts first. */
const version = (family: string) => (family.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '0').split(/[.-]/).map(Number);
function newerFirst(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
}
type Choice = Omit<TasteCandidate, 'key' | 'label' | 'status'>;

function samplePrompt(test: Pick<TasteTest, 'brief'>, notes: string, manuscript?: string): string {
  return `这是一次文风试写对比：几个执行器会分别写同一段内容，用户在不知道作者的情况下挑出最喜欢的一段。请按下面的写作要求，直接在回复里写一段 300～600 字的示范正文。
- 只输出正文本身，不要标题、说明、提问或任何解释，也不要提到这是试写。
- 不要创建或修改任何文件；需要时可以阅读项目里已有的文稿，了解人物、情节和现有文风。
- 要求涉及很长的内容时，只写最能体现文风的一小段。${
    manuscript
      ? `
- 这本书的正式正文在「${manuscript}」，需要了解前文时只读这里的章节。`
      : ''
  }${notes ? `\n\n${notes}` : ''}

写作要求：
${test.brief}`;
}

type Deps = {
  store: WorkspaceStore;
  controller: Controller;
  projectPath: (projectId: string) => string;
  publish: () => void;
  now: () => string;
};

export class TasteTests {
  constructor(private readonly deps: Deps) {}

  /** Recent tests, newest first. */
  list(limit = 40): TasteTest[] {
    return this.deps.store.list<TasteTest>('taste-test', undefined, limit);
  }

  /**
   * Starts a test of this kind of writing for the conversation's project, or returns the one still open. The
   * candidates are the router's picks on different platforms, filled up with another effort of the same model.
   */
  start(conversation: Conversation, brief: string, topic: WritingTopic, avoid = new Set<string>()): TasteTest {
    if (conversation.incognito) throw Error('隐身对话不能试写。');
    const open = this.list().find(
      (test) =>
        test.projectId === conversation.projectId &&
        test.topic === topic &&
        (test.status === 'writing' || test.status === 'ready'),
    );
    if (open) return open;
    const candidates = this.candidates(conversation.projectId, brief, topic, avoid);
    if (candidates.length < 2) throw new Error('可用来试写的执行器不到两个，没法对比。');
    const now = this.deps.now();
    const test: TasteTest = {
      id: randomUUID(),
      projectId: conversation.projectId,
      conversationId: conversation.id,
      topic,
      brief: brief.trim().slice(0, 4000),
      status: 'writing',
      candidates,
      createdAt: now,
      updatedAt: now,
    };
    this.save(test);
    void this.write(test.id);
    return test;
  }

  /**
   * Starts a test on its own for a writing request whose kind of writing the rules leave open, when the project
   * has no preference yet, or a model has appeared that its test did not compare. At most once a day per kind.
   */
  maybeStart(conversation: Conversation, project: Project, text: string): TasteTest | undefined {
    if (project.tasteTestsOff) return;
    if (!writingRequest(text)) return;
    const topic = writingTopic(text);
    if (!openTopic(conversation.routing, topic)) return;
    const since = Date.parse(this.deps.now()) - autoSpacingMs;
    if (
      this.list().some(
        (test) => test.projectId === project.id && test.topic === topic && Date.parse(test.createdAt) > since,
      )
    )
      return;
    const preference = project.writingPreferences?.find((item) => item.topic === topic);
    if (preference) {
      const now = this.candidates(project.id, text, topic);
      if (now.every((candidate) => preference.tested.includes(pairKey(candidate)))) return;
    }
    try {
      return this.start(conversation, text, topic);
    } catch {
      return undefined;
    }
  }

  /**
   * The user's pick, which can mean three different things: the best of this batch but still not good enough
   * (nothing is remembered), good enough this time, or good enough to become the project's default writer. Only
   * the last one is saved as a preference, and only then does its reason go into later writing.
   */
  choose(
    id: string,
    key: TasteCandidate['key'],
    options: { verdict?: TasteTest['verdict']; makeDefault?: boolean; reason?: string } = {},
  ): TasteTest {
    const test = this.require(id);
    if (test.status !== 'ready') throw new Error('这次试写还没写完，或已经选过了。');
    const pick = test.candidates.find((candidate) => candidate.key === key);
    if (!pick || pick.status !== 'done') throw new Error('这一段没有写成，不能选。');
    const verdict = options.verdict ?? 'better';
    if (options.makeDefault && verdict !== 'good') throw new Error('只有满意的那一段才能设为默认写手。');
    const project = this.deps.store.get<Project>('project', test.projectId);
    if (!project) throw new Error('项目不存在。');
    const note = options.reason?.trim().slice(0, 500) || undefined;
    const now = this.deps.now();
    if (options.makeDefault) {
      const preference: WritingPreference = {
        topic: test.topic,
        provider: pick.provider,
        model: pick.model,
        ...(pick.effort ? { effort: pick.effort } : {}),
        label: pick.label,
        ...(note ? { reason: note } : {}),
        chosenAt: now,
        testId: test.id,
        tested: test.candidates.map(pairKey),
      };
      project.writingPreferences = [
        ...(project.writingPreferences ?? []).filter((item) => item.topic !== test.topic),
        preference,
      ];
      project.updatedAt = now;
    }
    test.status = 'chosen';
    test.chosen = key;
    test.verdict = verdict;
    if (note) test.reason = note;
    this.deps.store.transaction(() => {
      if (options.makeDefault) this.deps.store.save('project', project.id, project.id, project);
      this.save(test, false);
    });
    this.deps.publish();
    return test;
  }

  /** None of them was good: closes the test and starts another with different models or efforts. */
  retry(id: string): TasteTest {
    const old = this.require(id);
    const conversation = this.deps.store.get<Conversation>('conversation', old.conversationId);
    if (!conversation || conversation.deletedAt) throw new Error('对话不存在。');
    this.dismiss(id);
    return this.start(conversation, old.brief, old.topic, new Set(old.candidates.map(variantKey)));
  }

  /** Closes a test without a pick; with stopAuto, no test starts on its own in this project again. */
  dismiss(id: string, stopAuto = false): TasteTest {
    const test = this.require(id);
    for (const candidate of test.candidates)
      if (candidate.status === 'writing' && candidate.runId) this.deps.controller.cancel(candidate.runId);
    if (test.status === 'writing' || test.status === 'ready' || test.status === 'failed') test.status = 'dismissed';
    if (stopAuto) {
      const project = this.deps.store.get<Project>('project', test.projectId);
      if (project) {
        project.tasteTestsOff = true;
        this.deps.store.save('project', project.id, project.id, project);
      }
    }
    this.save(test);
    return test;
  }

  /** Whether tests may start on their own in this project. */
  setAuto(projectId: string, enabled: boolean) {
    const project = this.deps.store.get<Project>('project', projectId);
    if (!project) throw new Error('项目不存在。');
    if (enabled) delete project.tasteTestsOff;
    else project.tasteTestsOff = true;
    this.deps.store.save('project', project.id, project.id, project);
    this.deps.publish();
  }
  /** Forgets a kind of writing's preference, so the next writing request tests again. */
  forget(projectId: string, topic: WritingTopic) {
    const project = this.deps.store.get<Project>('project', projectId);
    if (!project) throw new Error('项目不存在。');
    project.writingPreferences = (project.writingPreferences ?? []).filter((item) => item.topic !== topic);
    if (!project.writingPreferences.length) delete project.writingPreferences;
    delete project.tasteTestsOff;
    this.deps.store.save('project', project.id, project.id, project);
    this.deps.publish();
  }

  private candidates(
    projectId: string,
    brief: string,
    topic: WritingTopic,
    avoid = new Set<string>(),
  ): TasteCandidate[] {
    const { controller } = this.deps;
    const projectPath = this.deps.projectPath(projectId);
    const request = { prompt: brief, projectPath, kind: 'general' as const, executionPolicy: 'cli-only' as const };
    const routable = (choice: Choice) => {
      try {
        controller.preview({ ...request, runtimeId: choice.runtimeId, model: choice.model, effort: choice.effort });
        return true;
      } catch {
        return false;
      }
    };
    const efforts = (choice: Choice) =>
      [
        ...(controller.snapshots
          .find((snapshot) => snapshot.id === choice.runtimeId)
          ?.models.find((model) => model.id === choice.model)?.efforts ?? []),
      ].sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
    // Another effort of the same model, higher first, that is neither taken nor tried already.
    const otherEffort = (choice: Choice, taken: Set<string | undefined>) => {
      const ranked = efforts(choice);
      const at = ranked.indexOf(choice.effort ?? '');
      return [...ranked.slice(at + 1), ...ranked.slice(0, Math.max(0, at)).reverse()].find(
        (effort) => !taken.has(effort) && !avoid.has(variantKey({ ...choice, effort })),
      );
    };
    const picked: Choice[] = [];
    for (const provider of platforms[topic]) {
      if (picked.length >= keys.length) break;
      if (provider === 'cursor') {
        const choice = this.cursorChoice(topic, picked, avoid, routable);
        if (choice) picked.push(choice);
        continue;
      }
      try {
        const decision = controller.preview({ ...request, provider, permissionMode: 'read-only' });
        const choice: Choice = {
          provider,
          runtimeId: decision.runtimeId,
          model: decision.model,
          effort: decision.effort,
        };
        if (!avoid.has(variantKey(choice))) picked.push(choice);
        else {
          // Asked for another batch: the same model at another effort.
          const effort = otherEffort(choice, new Set([choice.effort]));
          if (effort) picked.push({ ...choice, effort });
        }
      } catch {
        /* Not ready, out of quota or without a model: the next platform takes its place. */
      }
    }
    // Fewer platforms than candidates: the same model at another effort fills in.
    for (const base of [...picked]) {
      if (picked.length >= keys.length) break;
      const used = new Set(
        picked.filter((item) => item.runtimeId === base.runtimeId && item.model === base.model).map((i) => i.effort),
      );
      const effort = otherEffort(base, used);
      if (effort) picked.push({ ...base, effort });
    }
    // Shuffled, so the letter says nothing about who wrote it.
    const order = picked.map((item) => ({ item, sort: Math.random() })).sort((a, b) => a.sort - b.sort);
    return order.map(({ item }, index) => ({
      ...item,
      key: keys[index]!,
      label: this.label(item),
      status: 'writing' as const,
    }));
  }

  /**
   * Cursor's candidate: the newest model of a maker the others do not already cover, at high effort; for adult
   * material a Grok model, preferably not the one the Grok candidate runs. Fast, small and coding variants are left
   * out, and so are builds marked "NO ZDR", which Cursor refuses to start here.
   */
  private cursorChoice(
    topic: WritingTopic,
    picked: Choice[],
    avoid: Set<string>,
    routable: (choice: Choice) => boolean,
  ): Choice | undefined {
    const snapshot = this.deps.controller.snapshots.find(
      (item) =>
        item.provider === 'cursor' &&
        item.status === 'ready' &&
        this.deps.controller.targets.some((target) => target.id === item.id && target.enabled),
    );
    if (!snapshot) return undefined;
    const makers = new Set(picked.map(makerOf));
    const families = new Set(picked.map((item) => item.model));
    const variants = snapshot.models
      .map((model) => ({ label: model.label, efforts: model.efforts, ...parseCursorModel(model.id) }))
      .filter(
        (variant) =>
          !variant.fast &&
          variant.family !== 'auto' &&
          (!variant.effort || variant.effort === 'high') &&
          !/(mini|nano|flash|codex|composer)/.test(variant.family) &&
          !/no\s*zdr/i.test(variant.label),
      );
    for (const maker of cursorMakers[topic]) {
      if (topic === 'prose' && makers.has(maker)) continue;
      const ranked = variants
        .filter((variant) => makerOf({ provider: 'cursor', model: variant.id }) === maker)
        .sort(
          (a, b) =>
            Number(families.has(a.family)) - Number(families.has(b.family)) ||
            newerFirst(version(a.family), version(b.family)),
        );
      for (const variant of ranked) {
        const choice: Choice = {
          provider: 'cursor',
          runtimeId: snapshot.id,
          model: variant.id,
          ...(variant.efforts.includes('high') ? { effort: 'high' } : {}),
        };
        if (!avoid.has(variantKey(choice)) && routable(choice)) return choice;
      }
    }
    return undefined;
  }

  private label(candidate: { runtimeId: string; model: string; effort?: string }): string {
    const { controller } = this.deps;
    const card = controller.targets.find((target) => target.id === candidate.runtimeId)?.label ?? candidate.runtimeId;
    const model =
      controller.snapshots
        .find((snapshot) => snapshot.id === candidate.runtimeId)
        ?.models.find((item) => item.id === candidate.model)?.label ?? candidate.model;
    return [card, model, candidate.effort].filter(Boolean).join(' · ');
  }

  /** Writes every sample at once, read-only; two finished samples are enough to compare. */
  private async write(id: string) {
    const test = this.require(id);
    const project = this.deps.store.get<Project>('project', test.projectId);
    const prompt = samplePrompt(test, preferenceNotes(project?.writingPreferences), project?.manuscript);
    await Promise.all(
      test.candidates.map(async (candidate) => {
        try {
          const run = await this.deps.controller.start({
            prompt,
            projectPath: this.deps.projectPath(test.projectId),
            kind: 'general',
            runtimeId: candidate.runtimeId,
            model: candidate.model,
            effort: candidate.effort,
            permissionMode: 'read-only',
            executionPolicy: 'cli-only',
          });
          this.update(id, candidate.key, { runId: run.id });
          const done = await this.finished(run.id);
          const text = done?.status === 'completed' ? samplePassage(done.output) : '';
          const confirmed = done?.effectiveModel;
          const actual = confirmed ? replayModelSelection(candidate.provider, confirmed) : candidate;
          this.update(
            id,
            candidate.key,
            text
              ? {
                  status: 'done',
                  text: text.slice(0, 8000),
                  ...(confirmed
                    ? {
                        model: actual.model,
                        effort: actual.effort,
                        label: this.label({ ...candidate, model: confirmed.model, effort: confirmed.effort }),
                        effectiveModel: confirmed,
                      }
                    : {}),
                }
              : { status: 'failed', error: done?.error || '没有写出内容。' },
          );
        } catch (error) {
          this.update(id, candidate.key, {
            status: 'failed',
            error: error instanceof Error ? error.message.slice(0, 300) : '启动失败。',
          });
        }
      }),
    );
    const final = this.require(id);
    if (final.status !== 'writing') return;
    const written = final.candidates.filter((candidate) => candidate.status === 'done').length;
    final.status = written >= 2 ? 'ready' : 'failed';
    if (written < 2) final.error = '写成的不到两段，没法对比；可以稍后再试。';
    this.save(final);
  }

  private async finished(runId: string): Promise<RunRecord | undefined> {
    const until = Date.now() + sampleLimitMs;
    for (;;) {
      const run = this.deps.controller.run(runId);
      if (!run || settled.includes(run.status)) return run;
      if (Date.now() > until) {
        this.deps.controller.cancel(runId);
        return { ...run, status: 'failed', error: '写得太久，已停止。' };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /** Changes one candidate on the saved test, so a pick or dismissal made meanwhile is kept. */
  private update(id: string, key: TasteCandidate['key'], patch: Partial<TasteCandidate>) {
    const test = this.deps.store.get<TasteTest>('taste-test', id);
    const candidate = test?.candidates.find((item) => item.key === key);
    if (!test || !candidate) return;
    Object.assign(candidate, patch);
    this.save(test);
  }

  private require(id: string): TasteTest {
    const test = this.deps.store.get<TasteTest>('taste-test', id);
    if (!test) throw new Error('试写对比不存在。');
    return test;
  }

  private save(test: TasteTest, publish = true) {
    test.updatedAt = this.deps.now();
    this.deps.store.save('taste-test', test.id, test.conversationId, test);
    if (publish) this.deps.publish();
  }
}
