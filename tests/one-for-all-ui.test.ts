import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationWorkspace } from '../src/ui/Workspace.tsx';
import { SettingsPage } from '../src/ui/App.tsx';
import type { AppState, Conversation, Project, Workflow } from '../src/shared/types.ts';

const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets: [],
  runtimes: [],
  runs: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
};
const actions = {
  api: async <T>() => ({}) as T,
  notify() {},
  reload: async () => {},
  onConversation() {},
  onAddProject() {},
  onMemory() {},
  onInspect() {},
};

test('a fresh conversation exposes an enabled composer without selecting a project or model', () => {
  const html = renderToStaticMarkup(createElement(ConversationWorkspace, { ...actions, state }));
  assert.match(html, /今天想完成什么/);
  assert.match(html, /placeholder="想做什么？"/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)?.[0] ?? '', /disabled/);
  assert.doesNotMatch(html, /先从左侧添加一个项目|任务模式|任务理解方式|任务执行器/);
  assert.match(html, /aria-label="调度选项"/);
});

test('confirmation card preserves the selected API route, delegation and streamed task state', () => {
  const project: Project = {
    id: 'p',
    name: '日常对话',
    path: 'C:/Fixture/chat',
    scope: 'chat',
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
  };
  const conversation: Conversation = {
    id: 'c',
    projectId: project.id,
    title: 'Example question',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  const workflow: Workflow = {
    id: 'w',
    conversationId: 'c',
    projectId: 'p',
    userMessageId: 'm',
    input: { content: 'Example question', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    status: 'waiting-confirmation',
    phase: 'route',
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    routingReview: {
      id: 'proposal',
      status: 'pending',
      proposal: {
        runtimeId: 'api-deepseek',
        model: 'deepseek/deepseek-chat',
        effort: 'high',
        kind: 'general',
        reasons: ['fixture reason'],
        warnings: [],
      },
      original: {},
      proposedAt: project.createdAt,
    },
  };
  const viewed: AppState = {
    ...state,
    targets: [
      {
        id: 'api-deepseek',
        gateway: 'api',
        apiProvider: 'deepseek',
        provider: 'pi',
        label: 'DeepSeek API',
        command: 'unused',
        enabled: true,
        environment: 'native',
      },
    ],
    projects: [project],
    conversations: [conversation],
    workflows: [workflow],
    conversationMessages: [
      {
        id: 'm',
        conversationId: 'c',
        role: 'user',
        content: 'Example question',
        workflowId: 'w',
        createdAt: project.createdAt,
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ConversationWorkspace, { ...actions, state: viewed, project, conversation }),
  );
  // Ordinary chats keep their route confirmation and never offer child creation.
  assert.doesNotMatch(html, /审查或委派/);
  const completedHtml = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      ...actions,
      state: { ...viewed, workflows: [{ ...workflow, status: 'completed' }] },
      project,
      conversation,
    }),
  );
  assert.doesNotMatch(completedHtml, /审查或委派/);
  // Child creation stays in Collaboration even after a project task finishes.
  const managedProject: Project = { ...project, name: 'Fixture project', scope: 'project' };
  const confirmingProjectHtml = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      ...actions,
      state: { ...viewed, projects: [managedProject] },
      project: managedProject,
      conversation,
    }),
  );
  assert.doesNotMatch(confirmingProjectHtml, /审查或委派/);
  const completedProjectHtml = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      ...actions,
      state: { ...viewed, projects: [managedProject], workflows: [{ ...workflow, status: 'completed' }] },
      project: managedProject,
      conversation,
    }),
  );
  assert.doesNotMatch(completedProjectHtml, /审查或委派/);
  const childHtml = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      ...actions,
      state: {
        ...viewed,
        projects: [managedProject],
        workflows: [
          {
            ...workflow,
            status: 'completed',
            delegation: {
              parentId: 'parent-task',
              role: 'reviewer',
              requestId: 'fixture-request',
              crossCheck: { of: 'codex' },
            },
          },
        ],
      },
      project: managedProject,
      conversation,
    }),
  );
  assert.match(childHtml, /子任务 · 审查（交叉审查 Codex 的结果）/);
  assert.doesNotMatch(childHtml, /审查或委派|reviewer/);
  // A running single-step task reads like a normal reply: details stay folded, thinking and answer stream below.
  const running = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      ...actions,
      state: {
        ...viewed,
        workflows: [
          {
            ...workflow,
            status: 'running',
            phase: 'execute',
            routingReview: undefined,
            runIds: ['r'],
            plan: [
              {
                id: 's',
                title: '回答问题',
                instruction: 'answer',
                kind: 'general',
                transport: 'auto',
                dependsOn: [],
                status: 'running',
                runIds: ['r'],
              },
            ],
          },
        ],
        runs: [
          {
            id: 'r',
            workflowId: 'w',
            stepId: 's',
            prompt: 'Example question',
            projectPath: project.path,
            kind: 'general',
            status: 'running',
            route: {
              runtimeId: 'api-deepseek',
              model: 'deepseek/deepseek-chat',
              kind: 'general',
              reasons: [],
              warnings: [],
            },
            startedAt: project.createdAt,
            output: 'Partial answer',
            reasoning: 'Thinking it through\nBody',
            events: [],
          },
        ],
      },
      project,
      conversation,
    }),
  );
  assert.match(running, /<div[^>]*class="workflow-trace workflow-running"[^>]*><details>/);
  assert.match(running, /turn-tail/);
  assert.match(running, /处理中/);
  assert.match(running, /Thinking it through/);
  assert.match(running, /Partial answer/);
  const card = running.match(/<div[^>]*class="workflow-trace[\s\S]*?<div class="message-heading">/)?.[0] ?? running;
  assert.doesNotMatch(card, /execution-chip|planning-run|trace-context/);
  assert.match(card, /class="button tiny quiet trace-link"[^>]*>查看轨迹/);
  assert.doesNotMatch(running, /stream-stop|停止工作流|你的选择/);
  assert.match(html, /确认并运行/);
  assert.match(html, /deepseek\/deepseek-chat/);
  assert.match(html, /high/);
  assert.match(html, /aria-label="运行前确认"/);
});

test('decision mode is automatic by default and configurable to confirmation in settings', () => {
  const auto = renderToStaticMarkup(createElement(SettingsPage, { category: 'routing', ...actions, state }));
  assert.match(auto, /value="auto" selected="">自动选择并运行/);
  const confirm = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'routing',
      ...actions,
      state: { ...state, settings: { ...state.settings, decisionMode: 'confirm' } },
    }),
  );
  assert.match(confirm, /value="confirm" selected="">先给建议，确认后运行/);
});
