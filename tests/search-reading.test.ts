import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationHistory } from '../src/ui/Workspace.tsx';
import type { AppState, ConversationMessage } from '../src/shared/types.ts';
import { WebSearchReply, savedSearchSources, searchAnswerLabel } from '../src/ui/WebSearchReply.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { conversationTimeline } from '../src/ui/conversation-timeline.ts';

test('a search receipt stays under its question even when same-timestamp live messages arrive in reverse order', () => {
  const source = {
    id: 'source',
    role: 'assistant',
    conversationId: 'chat',
    createdAt: '2026-10-24T21:50:25.317Z',
    content: 'sources',
    webSearch: { query: 'OMDS value', status: 'completed' },
  } as ConversationMessage;
  const question = {
    id: 'question',
    role: 'user',
    conversationId: 'chat',
    createdAt: source.createdAt,
    content: '/搜索 OMDS value',
    webSearch: { query: 'OMDS value', status: 'completed', replyId: 'source' },
  } as ConversationMessage;
  const rows = conversationTimeline([source, question], []);
  assert.deepEqual(
    rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)),
    ['question', 'source'],
  );
  const foreign = { ...question, conversationId: 'other' };
  assert.deepEqual(
    conversationTimeline([source, foreign], []).map((row) => (row.kind === 'message' ? row.message.id : row.kind)),
    ['source', 'question'],
  );
});

test('search progress follows its real answer workflow and source links reject unsafe URLs', () => {
  const message = {
    content: '',
    webSearch: {
      query: 'q',
      status: 'completed',
      results: [
        { url: 'javascript:alert(1)', title: 'bad', summary: '' },
        { url: 'https://example.com', title: 'safe', summary: 'paragraph' },
      ],
      answer: { status: 'started', workflowId: 'answer' },
    },
  } as ConversationMessage;
  assert.equal(savedSearchSources(message).length, 1);
  assert.match(searchAnswerLabel(message, { status: 'running' } as any), /正在整理回答/);
  assert.match(searchAnswerLabel(message, { status: 'completed' } as any), /已整理回答/);
  assert.match(searchAnswerLabel(message, { status: 'failed' } as any), /回答已停止/);
  assert.match(searchAnswerLabel(message, { status: 'waiting-approval' } as any), /等待确认/);
});

test('historical search only starts an answer after clicking and reports unavailable executors', async () => {
  const h = uiHarness(await uiBundle('src/ui/WebSearchReply.tsx'));
  const calls: string[] = [];
  const message = {
    id: 'source',
    conversationId: 'chat',
    content: 'Legacy sources',
    webSearch: { query: 'q', status: 'completed' },
  } as ConversationMessage;
  const props = {
    message,
    api: async (path: string) => {
      calls.push(path);
      return {
        reply: {
          ...message,
          webSearch: { ...message.webSearch, answer: { status: 'unavailable', error: 'No enabled executor' } },
        },
      };
    },
  };
  const render = () => h.render('WebSearchReply', props);
  render();
  await nextTurn();
  assert.deepEqual(calls, []);
  findNode(render(), (node) => node.type === 'button')!.props.onClick();
  await nextTurn();
  assert.deepEqual(calls, ['/api/conversations/chat/messages/source/search-answer']);
  assert.match(text(render()), /No enabled executor/);
  assert.ok(findNode(render(), (node) => node.type === 'button'));
  h.unmount();
});

test('saved search evidence is collapsed and rendered as separate readable sources in conversation history', () => {
  const message: ConversationMessage = {
    id: 'search',
    conversationId: 'chat',
    role: 'assistant',
    createdAt: '2026-10-24T12:00:00Z',
    content:
      '搜索：dates\n\n1. [Official dates](<https://example.com/dates>)\n\n> First paragraph.\n> Second paragraph.\n\n来源：DeepSeek 搜索 · 耗时 0.53 秒 · 预计费用 ¥0.005',
    replyIdentity: { automatic: false, kind: 'system', runs: [] },
    webSearch: {
      query: 'dates',
      searchQuery: 'OMDS registration dates',
      status: 'completed',
      durationMs: 530,
      estimatedCostCny: 0.005,
    },
  };
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [message],
      workflows: [],
      state: { targets: [], runtimes: [], runs: [], workflows: [], settings: {} } as unknown as AppState,
      api: async () => {
        throw Error('Rendering must not search or call a model');
      },
      notify: () => {},
      onInspect: () => {},
    }),
  );
  assert.match(html, /class="web-search-sources"/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.match(html, /href="https:\/\/example.com\/dates"/);
  assert.match(html, /class="web-search-source"/);
  assert.match(html, /实际检索：OMDS registration dates/);
  assert.match(html, /整理成回答/);
  assert.doesNotMatch(html, /class="system-notice-text"/);
});

const summaryMarkup = (summary: string, date?: string) =>
  renderToStaticMarkup(
    createElement(WebSearchReply, {
      message: {
        id: 'search',
        conversationId: 'chat',
        role: 'assistant',
        content: '',
        createdAt: '',
        webSearch: {
          query: 'q',
          status: 'completed',
          results: [{ title: 'Source', url: 'https://example.com/source', summary, date }],
        },
      } as ConversationMessage,
    }),
  );

test('full summaries use safe article headings, lists, tables and code while previews contain readable text', () => {
  const summary =
    '## Registration guide\n\n**Check the official dates.** ' +
    'A readable explanation of the source. '.repeat(10) +
    '\n\n### Steps\n\n- Check the course\n- Save the date\n\n| Step | Action |\n| --- | --- |\n| One | Read |\n\n```text\nexample code\n```';
  const html = summaryMarkup(summary, '2026-10-24T23:30:00.000Z');
  assert.match(html, /<h3>Registration guide<\/h3>/);
  assert.match(html, /<h4>Steps<\/h4>/);
  assert.match(html, /<strong>Check the official dates\.<\/strong>/);
  assert.match(html, /<ul><li>Check the course<\/li><li>Save the date<\/li><\/ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code>example code<\/code><\/pre>/);
  assert.match(html, /class="web-search-source-full"/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  const preview = /class="web-search-source-preview"[^>]*>([^<]*)<\/p>/.exec(html)?.[1];
  assert.ok(preview);
  assert.doesNotMatch(preview, /##|\*\*|\| ---/);
  assert.match(preview, /Registration guide/);
  assert.match(html, /<time dateTime="2026-10-24T23:30:00.000Z">2026年10月24日<\/time>/);
});

test('source summaries cannot load images, execute HTML, open local files or create unsafe links', () => {
  const summary =
    '![Tracker alt](https://tracker.invalid/pixel.gif)\n\n' +
    '<img src="https://tracker.invalid/raw.gif" onerror="alert(1)"><script>alert(1)</script><iframe src="https://tracker.invalid/frame"></iframe>\n\n' +
    '[safe](https://example.org/read) [unsafe](javascript:alert) [data](data:text/html,bad) [credentials](https://user:password@example.org/) [local](file:///C:/private.txt) `C:/private.txt`';
  const html = summaryMarkup(summary);
  assert.doesNotMatch(html, /<(?:img|script|iframe)\b|data-local-path|data-relative-path|role="button"/i);
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(links.includes('https://example.org/read'));
  assert.ok(links.every((href) => /^https?:\/\//.test(href!)));
  assert.ok(links.every((href) => !/user:password|file:|javascript:|data:/.test(href!)));
  assert.doesNotMatch(html, /pixel\.gif/);
  assert.match(html, /Tracker alt/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('short Markdown, empty summaries, long URLs and unknown dates keep usable source entries', () => {
  assert.match(summaryMarkup('## Short heading\n\n- One\n- Two'), /<h3>Short heading<\/h3><ul>/);
  const empty = summaryMarkup('   ', 'Date unavailable');
  assert.match(empty, /href="https:\/\/example.com\/source"/);
  assert.doesNotMatch(empty, /web-search-source-full|web-search-source-article/);
  assert.match(empty, /Date unavailable/);
  const long = summaryMarkup('https://example.org/' + 'verylongpath'.repeat(40));
  assert.match(long, /href="https:\/\/example.org\/verylongpath/);
  const url = 'https://example.org/' + 'long-path-'.repeat(100);
  const fallback = renderToStaticMarkup(
    createElement(WebSearchReply, {
      message: {
        id: 'fallback',
        conversationId: 'chat',
        role: 'assistant',
        content: '',
        createdAt: '',
        webSearch: { query: 'q', status: 'completed', results: [{ title: '', url, summary: '' }] },
      } as ConversationMessage,
    }),
  );
  const label = /<a[^>]*>([^<]+)<\/a>/.exec(fallback)?.[1];
  assert.ok(label && label.length <= 80 && label.endsWith('…'));
  assert.ok(fallback.includes(`href="${url}"`));
});
