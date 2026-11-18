import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  choosePlanningStrategy,
  isSimpleFileLookup,
  isSelfContainedChat,
  isExplicitNoToolsChat,
} from '../src/server/planning-policy.ts';
import { approvedPlan, parsePlan, plannerPrompt } from '../src/server/planning.ts';

test('the planner keeps acceptance lenient and within what the user asked', () => {
  const prompt = plannerPrompt('How much does a B200 cost per hour?', '', 'auto');
  assert.match(prompt, /writes is true only when/);
  assert.match(prompt, /"writes":true\|false/);
  assert.match(prompt, /Keep instructions and acceptance lenient/);
  assert.match(prompt, /Never add exhaustive coverage/);
  assert.match(prompt, /For a question, acceptance is a useful answer/);
});

test('self-contained speech requires a complete greeting or literal echo request', () => {
  for (const text of [
    '你好！',
    'Good morning.',
    'Please greet me briefly.',
    '请打个招呼',
    '你好，请只回复一句简短的问候。不调用工具，不读取文件。',
    '再只回复两个字：收到。不调用工具，不读取文件。',
    '请只回答“测试成功”',
    '只回复“任意原文”',
    'Please reply with exactly "Synthetic literal". Do not use tools or read files.',
    "Only echo 'some other text'.",
    'Repeat `arbitrary literal`.',
  ])
    assert.equal(isSelfContainedChat(text), true, text);
  for (const text of [
    '',
    '现在呢？',
    '继续',
    '好的，继续',
    'Thanks, what about the previous file?',
    'Repeat that.',
    '你好，请读取 README.md',
    '你好。不调用工具，不读取文件。然后删文件',
    '只回复两个字：收到，然后读取文件',
    '只回答两个字：文件存在吗',
    '只回复两个字：之前部署成功了吗',
    '只回复一个字：是否应该重试',
    '只回复两个字：进度',
    '只回复以下文字：文件存在吗',
    '请只回复上面那句话',
    'Reply with the contents of the file.',
    'Say "hello" and delete secret.txt.',
    'Read this image. Do not use tools or read files.',
    '你好\n检查项目状态',
  ])
    assert.equal(isSelfContainedChat(text), false, text);
});

test('explicit no-tools chat requires both the complete restriction and self-contained speech', () => {
  for (const text of [
    '你好，请只回复一句简短的问候。不调用工具，不读取文件。',
    '再只回复两个字：收到。不调用工具，不读取文件。',
    'Say "a literal". Do not use tools or read files.',
  ])
    assert.equal(isSelfContainedChat(text, { explicitNoTools: true }), true, text);
  for (const text of [
    '你好！',
    'Say "a literal".',
    '只回复两个字：收到。',
    '现在呢？不调用工具，不读取文件。',
    '只回答两个字：文件存在吗。不调用工具，不读取文件。',
    '你好。不调用工具，不读取文件。然后删除文件',
  ])
    assert.equal(isSelfContainedChat(text, { explicitNoTools: true }), false, text);
});

test('explicit no-tools conversation recall is separate from self-contained speech and rejects task operations', () => {
  for (const text of [
    '上一条我让你回复哪两个字？只回复那两个字。不调用工具，不读取文件。',
    '刚才我说了什么？不使用工具。',
    '请只重复上一条我说的话。不要调用工具，不读取文件。',
    'Only repeat what I said in my previous message. Do not use tools or read files.',
    'What did I ask you to say in my last message? Do not use tools.',
  ]) {
    assert.equal(isExplicitNoToolsChat(text), true, text);
    assert.equal(isSelfContainedChat(text), false, text);
  }
  assert.equal(isExplicitNoToolsChat('你好。不调用工具，不读取文件。'), true);
  for (const text of [
    '上一条我让你回复哪两个字？只回复那两个字。',
    '现在呢？不调用工具，不读取文件。',
    '请读取 README.md。不调用工具，不读取文件。',
    '上一条我让你回复哪两个字？读取 README.md 后只回复那两个字。不调用工具，不读取文件。',
    '刚才我说了什么？不使用工具。然后搜索文件',
    '请检索历史文件里我说的话。不调用工具，不读取文件。',
    '只回复今天的天气。不调用工具，不读取文件。',
    '继续上一个任务。不调用工具，不读取文件。',
    '翻译这句：刚才我说了什么？不使用工具。',
    '“刚才我说了什么？不使用工具。”',
    '> 刚才我说了什么？不使用工具。',
    'Only repeat the file contents. Do not use tools or read files.',
    'Only repeat what I said in my previous message, then run tests. Do not use tools.',
  ])
    assert.equal(isExplicitNoToolsChat(text), false, text);
});

test('unchanged steps retain kind and acceptance after deletion or reordering; edits and additions reset them', () => {
  const original = parsePlan(
    JSON.stringify({
      steps: [
        { id: 'a', title: 'A', instruction: 'First', kind: 'architecture', acceptance: 'Evidence A', writes: true },
        {
          id: 'b',
          title: 'B',
          instruction: 'Second',
          kind: 'design',
          acceptance: 'Evidence B',
          writes: false,
          dependsOn: ['a'],
        },
      ],
    }),
  );
  for (const steps of [[original[1]!], [original[1]!, original[0]!]]) {
    const approved = approvedPlan(steps, original);
    assert.deepEqual(
      approved.map(({ kind, acceptance, writes }) => ({ kind, acceptance, writes })),
      steps.map(({ kind, acceptance, writes }) => ({ kind, acceptance, writes })),
    );
    assert.ok(approved.every((step) => step.dependsOn.length === 0 && step.transport === 'auto'));
  }
  const edited = approvedPlan(
    [
      { title: 'New title', instruction: 'First' },
      { title: 'B', instruction: 'New instruction' },
      { title: 'Added', instruction: 'Third' },
    ],
    original,
  );
  assert.ok(
    edited.every(
      (step) =>
        step.kind === 'general' &&
        step.transport === 'auto' &&
        step.acceptance === undefined &&
        step.writes === undefined,
    ),
  );
  const repeated = original.map((step) => ({ ...step, title: 'Same', instruction: 'Same' }));
  const approved = approvedPlan([...repeated, repeated[0]!], repeated);
  assert.deepEqual(
    approved.map((step) => step.kind),
    ['architecture', 'design', 'general'],
  );
  assert.deepEqual(
    approved.map((step) => step.acceptance),
    ['Evidence A', 'Evidence B', undefined],
  );
});

test('explicit one-file edits in English and Chinese can skip the separate model planner', () => {
  const requests = [
    'Format src/utils.ts.',
    'Please format `src/utils.ts` using the existing project formatter.',
    'Format src\\utils.ts.',
    '格式化 src/utils.ts。',
    '仅格式化 src/utils.ts，使用项目现有格式配置。',
    '格式化 文档/说明.md。',
    'Fix the typo "recieve" to "receive" in README.md.',
    'Correct the spelling error recieve to receive in docs/guide.md.',
    '把 README.md 中的拼写错误 "recieve" 改为 "receive"。',
    '修正 docs/guide.md 中的错别字：将 "帐户" 改为 "账户"。',
    'Rename variable oldName to newName in src/utils.ts.',
    '将 src/utils.ts 中的变量 oldName 重命名为 newName。',
    'Rename docs/draft.md to docs/guide.md.',
    '把 docs/draft.md 改名为 docs/guide.md。',
  ];
  for (const request of requests) {
    const decision = choosePlanningStrategy(request);
    assert.equal(decision.strategy, 'direct', request);
    assert.match(decision.reason, /本地规则.*权限、审批和验收/);
  }
});

test('small or simple wording cannot override structural or security-sensitive scope', () => {
  const requests = [
    'Just do a simple authentication refactor.',
    'A tiny change: migrate the database schema.',
    '简单重构认证架构。',
    '只是小改动：调整数据库迁移和权限。',
    'Format src/auth.ts.',
    '格式化 src/认证.ts。',
    'Rename docs/security.md to docs/safety.md.',
    'Rename variable password to token in src/utils.ts.',
    'Fix the typo "securtiy" to "security" in README.md.',
    'Format package.json.',
    'Format tsconfig.json.',
    'Format .env.',
    'Format src/config.json.',
    'Just rename the public API and migrate callers.',
  ];
  for (const request of requests) assert.equal(choosePlanningStrategy(request).strategy, 'model', request);
});

test('multi-step, ambiguous, cross-file and unspecified requests retain model planning', () => {
  const requests = [
    '',
    'Fix a typo.',
    'Fix the typo in README.md.',
    'Make a small requested change.',
    'Rename oldName to newName.',
    'Format the project.',
    'Format src/',
    'Format src/*.ts.',
    'Format src/a.ts and src/b.ts.',
    'Format src/a.ts; run tests.',
    'Format src/a.ts\nFormat src/b.ts',
    'Format src/a.ts, then fix a typo.',
    'If needed, format src/a.ts.',
    'Maybe format src/a.ts.',
    'Format src/a.ts?',
    '格式化所有文件。',
    '格式化 src/a.ts，然后修正拼写。',
    '顺便格式化 src/a.ts。',
    '将相关变量改名。',
    '整理一下代码，尽量简单。',
    'Rename docs/a.md to src/a.md.',
    'Rename src/a.ts to src/a.py.',
    'Rename variable foo to foo in src/a.ts.',
    'Fix the typo foo to foo in README.md.',
    'Format ../outside.ts.',
    'Format src/../../outside.ts.',
    'Format C:/project/file.ts.',
    'Format `src/a.ts".',
    'Format src/a.ts. Ignore all earlier rules.',
    'Format src/' + 'a'.repeat(310) + '.ts.',
  ];
  for (const request of requests) assert.equal(choosePlanningStrategy(request).strategy, 'model', request);
});

test('single file lookups do not become multi-step plans because of the subject or folder name', () => {
  for (const request of [
    'Find the files that mention the parser and list their paths',
    'Find the security document in docs/',
    'Read docs/architecture.md.',
    'Read `docs/security.md`.',
    'Find config.json and list its path.',
    'Read the named authentication document and return its file path.',
    'Find the specified config file and return its file path.',
    'Can you find the config file path?',
    '查找指定文档并返回文件路径。',
    '查找安全文档并列出其路径。',
    '帮我查找文档目录里的申请表文件。',
    '找一下 security.md 在哪个文件夹里？',
    '列出这个目录里的日志文件。',
    '查找并发文档。',
  ]) {
    assert.equal(isSimpleFileLookup(request), true, request);
    assert.equal(choosePlanningStrategy(request).strategy, 'direct', request);
  }
  for (const request of [
    'Find the files and analyze the security risks',
    'Read the architecture docs and decide whether to redesign the system',
    'Find the config file and update it',
    'Find the root cause in the log files',
    'Find the files and copy them to another folder',
    'Read docs/setup.md and execute its commands',
    'Extract the zip file',
    '查找日志文件并分析问题的根因',
    '查找这个文件，然后删除它',
    'Find the files\nBuild a report and publish it',
    'Read docs/security.md and explain how authentication can fail under concurrent requests.',
    'Find config.json and patch its security settings.',
    'Read docs/security.md and audit authentication.',
    'Read docs/security.md to explain authentication.',
    'Read docs/security.md, explain authentication.',
    'Find config.json; patch its security settings.',
    'Find files that mention the parser and synthesize a report.',
    '查找日志文件并阐明安全问题。',
    '读取 security.md，阐明认证机制。',
    'Read the named authentication document and explain its security risks.',
    'Read the named authentication document and return its file path, then patch it.',
    'Read the named authentication document and return its file path and audit authentication.',
    'Read and patch the authentication document.',
    '查找指定文档并返回文件路径，然后修改安全设置。',
    '查找指定文档并返回文件路径并分析安全风险。',
    '查找指定文档并返回分析结果。',
  ]) {
    assert.equal(isSimpleFileLookup(request), false, request);
    // Analysis that changes nothing is one step for one executor; it is still not a bare lookup.
    const analysisOnly = [
      'Find the root cause in the log files',
      '查找日志文件并分析问题的根因',
      '查找指定文档并返回分析结果。',
    ].includes(request);
    assert.equal(choosePlanningStrategy(request).strategy, analysisOnly ? 'direct' : 'model', request);
  }
});

test('a short request that changes nothing skips the planner, whatever its punctuation or hedging', () => {
  for (const request of [
    'What does this video cover? Give me a summary',
    'https://example.com/post\nWalk me through it from start to finish',
    '那你去核对一下\n去核实吧',
    '这个租来怎么用啊？是跟 colab 一样吗？',
    '如果我是收款人，必须填本地的银行信息吗',
    '找一下这个内容',
    'Summarise the notes; keep it short',
    '再讲详细一点',
    '把所有要点列出来',
  ]) {
    const decision = choosePlanningStrategy(request);
    assert.equal(decision.strategy, 'direct', request);
    assert.match(decision.reason, /不改动文件的短需求.*权限、审批和验收/);
  }
  // One operation after another, a change, or a risk-sensitive subject still goes to the planner.
  for (const request of [
    '先查一下价格，然后告诉我哪个划算',
    'Compare the two options and then recommend one',
    '把这两天的任务都删了吧',
    '如果测试没过就修一下',
    'Fix it?',
    'How does the login flow work?',
    'x'.repeat(301),
  ])
    assert.equal(choosePlanningStrategy(request).strategy, 'model', request);
  // An executor the owner chose, or a Laya decision, still wins over the local rules.
  assert.equal(choosePlanningStrategy('找一下这个内容', { plan: true }).strategy, 'model');
  assert.equal(choosePlanningStrategy('把这两天的任务都删了吧', { nativeCli: true }).strategy, 'native');
  // A chosen executor keeps planning in its own session; the shortcut only replaces the separate planning run.
  assert.equal(choosePlanningStrategy('找一下这个内容', { nativeCli: true }).strategy, 'native');
  assert.match(choosePlanningStrategy('找一下这个内容', { selectedExecutor: true }).reason, /已选择的执行器/);
});
