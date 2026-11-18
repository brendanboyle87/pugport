import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MentionMenu, mentionItems } from '../src/ui/Mentions.tsx';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const writingCode = await uiBundle('src/ui/TasteTest.tsx');

test('writing tools and manuscript reads only appear for fiction projects', async () => {
  for (const fiction of [false, true]) {
    const h = uiHarness(writingCode);
    const reads: string[] = [];
    const props = {
      conversation: { id: 'synthetic-chat', projectId: 'synthetic-project' },
      state: {
        projects: [
          { id: 'synthetic-project', path: '/synthetic', ...(fiction ? { manuscript: '/synthetic/book' } : {}) },
        ],
      },
      api: async (path: string) => {
        reads.push(path);
        return [];
      },
      notify() {},
    };
    const tree = h.render('WritingPreferences', props);
    await nextTurn();
    if (fiction) {
      assert.match(text(tree), /正式正文/);
      assert.deepEqual(reads, ['/api/projects/synthetic-project/manuscript-candidates']);
    } else {
      assert.equal(tree, null);
      assert.deepEqual(reads, []);
    }
    h.unmount();
  }
});

test('mention picker uses a role icon and executor brand marks with one group explanation', () => {
  const target = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
    id,
    provider,
    label,
    command: 'unused',
    environment: 'native',
    enabled: true,
  });
  const items = mentionItems(
    [
      {
        id: 'review',
        name: 'Review',
        description: 'Check this answer',
        instructions: '',
        mode: 'chat',
        permissionMode: 'read-only',
      },
    ],
    [
      target('claude', 'claude', 'My writer'),
      target('codex', 'codex', 'My reviewer'),
      { ...target('api', 'pi', 'Custom account'), gateway: 'api', apiProvider: 'openai' },
    ],
  );
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      items,
      active: 0,
      onHover() {},
      onPick() {},
      onCreate() {},
    }),
  );
  assert.match(html, /lucide-user-round/);
  assert.match(html, /provider-claude/);
  assert.match(html, /provider-codex/);
  assert.match(html, /provider-api[^>]*>O<\/span>/);
  assert.equal(html.match(/直接交给它回答这一条/g)?.length, 1);
  assert.ok(items.filter((item) => item.kind === 'executor').every((item) => !item.description));
});
