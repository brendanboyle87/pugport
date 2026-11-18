import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { extensions } from '../src/server/extensions.ts';
import type { RunInput, RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'synthetic-media-agent',
  provider: 'codex',
  label: 'Synthetic media agent',
  command: 'never-spawn',
  environment: 'native',
  enabled: true,
};

type HintController = {
  bridgeTokens: Map<string, { write: boolean; recycle: boolean; delegate: boolean; child: boolean }>;
  targets: RuntimeTarget[];
  withBridgeHints(input: RunInput, target: RuntimeTarget, token: string): RunInput;
};

function hinted(input: Pick<RunInput, 'prompt' | 'routingPrompt' | 'continuationPrompt'>, write = true) {
  // Exercise the same prompt composition used for native execution and continuation, without
  // constructing stores, discovering accounts, or starting an executor for a policy-only test.
  const controller = Object.create(Controller.prototype) as HintController;
  controller.targets = [target];
  controller.bridgeTokens = new Map([['synthetic-token', { write, recycle: write, delegate: false, child: false }]]);
  return controller.withBridgeHints(
    {
      ...input,
      projectPath: 'synthetic-media-scope',
      kind: 'general',
      permissionMode: write ? 'workspace-write' : 'read-only',
      skills: [],
    },
    target,
    'synthetic-token',
  );
}

test('authorized media deduplication preserves exact-copy recycling but cannot promote sampled matches', (t) => {
  t.mock.method(extensions, 'skillHint', () => undefined);
  const prompt = hinted({ prompt: '整理图片和视频，重复的保留高清版，低清版放回收站，包括长视频覆盖短片。' }).prompt;
  assert.match(prompt, /exact-bytes.*完整哈希一致、文件未变化且保留副本仍存在/);
  assert.match(prompt, /无需重复询问已明确授权的操作/);
  assert.match(prompt, /sampled-full-span.*partial-overlap.*image-candidate.*不能.*自动回收依据/);
  assert.match(prompt, /短片全部内容被覆盖、没有独有画面或音轨字幕，且保留版本实际画质不差/);
  assert.match(prompt, /当前 analyze_media.*没有完成这套覆盖、音轨字幕及画质核验/);
  assert.match(prompt, /证据不足的保留并列出/);
  assert.doesNotMatch(prompt, /逐字节相同和整段重复的组|清晰度最高，其次文件最大/);
  assert.match(prompt, /分析结束不等于分类或回收已完成/);
});

test('bulk media instructions avoid hashing the same scope twice while ordinary exact-file tasks retain the helper', (t) => {
  t.mock.method(extensions, 'skillHint', () => undefined);
  const media = hinted({ prompt: '把图片按人物归类并去重。' }).prompt;
  assert.match(media, /analyze_media 已包含完整文件哈希查重，不再对相同媒体范围另跑 find_duplicates/);
  assert.match(media, /find_duplicates 用于非媒体文件，或仅需逐字节查重且尚未启动媒体分析的任务/);
  const documents = hinted({ prompt: '整理合同文档，清理内容完全相同的文件。' }).prompt;
  assert.match(documents, /find_duplicates 找内容完全相同的文件/);
  assert.doesNotMatch(documents, /analyze_media/);
});

test('media policy is appended to resumed prompts without granting writes to read-only runs', (t) => {
  t.mock.method(extensions, 'skillHint', () => undefined);
  const input = {
    prompt: '继续这次分析。',
    routingPrompt: '只读比较长视频和短片，查重但不删除。',
    continuationPrompt: '继续已存在的本地分析任务。',
  };
  const result = hinted(input, false);
  const suffix = result.prompt.slice(input.prompt.length);
  assert.ok(suffix.includes('sampled-full-span'));
  assert.equal(result.continuationPrompt, input.continuationPrompt + suffix);
  assert.match(result.prompt, /这次是只读，不能移动或删除文件/);
  assert.doesNotMatch(result.prompt, /PugPort 不额外确认|移动、改名、删除用 organize_files/);
  assert.equal(result.permissionMode, 'read-only');
});

test('writable Codex receives patch recovery instructions', () => {
  const prompt = hinted({ prompt: 'edit code' }).prompt;
  assert.match(prompt, /先重新读取该文件的当前内容/);
  assert.equal(prompt.includes('在 Windows 上用 PowerShell'), process.platform === 'win32');
  assert.doesNotMatch(hinted({ prompt: 'read code' }, false).prompt, /先重新读取该文件的当前内容/);
  const controller = Object.create(Controller.prototype) as HintController;
  controller.targets = [{ ...target, provider: 'cursor' }];
  controller.bridgeTokens = new Map();
  const cursor = controller.withBridgeHints(
    { prompt: 'edit code', projectPath: 'synthetic', kind: 'general', permissionMode: 'workspace-write' },
    controller.targets[0]!,
    'synthetic-token',
  );
  assert.doesNotMatch(cursor.prompt, /先重新读取该文件的当前内容/);
});
