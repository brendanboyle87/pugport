import assert from 'node:assert/strict';
import { test } from 'node:test';
import { externalInvocation } from '../src/shared/external-agents.ts';

const agents = [
  { id: 'muse', name: 'Muse' },
  { id: 'grok-bot', name: 'Grok Bot' },
];

test('direct natural-language instructions select only exact known agent names and aliases', () => {
  for (const content of [
    '让Muse回答这个问题',
    '调用muse，解释这个问题',
    '请帮我调用Muse解释这个问题',
    'call Muse to answer this question',
    'Please ask M-U-S-E to explain this question',
    '请m-u-s-e回答这个问题',
    'M-U-S-E 回答这个问题',
    '我要call一下这个Muse，回答这个问题',
    '请帮我call一下M-U-S-E回答这个问题',
  ])
    assert.equal(externalInvocation(content, agents)?.id, 'muse', content);
  assert.equal(externalInvocation('请调用Grok Bot，回答这个问题', agents)?.id, 'grok-bot');
  assert.equal(externalInvocation('ask Grok Bot to review this code', agents)?.id, 'grok-bot');
  assert.equal(
    externalInvocation(
      '让Muse回答这个问题',
      agents.filter((agent) => agent.id !== 'muse'),
    ),
    undefined,
  );
  assert.equal(externalInvocation('让Unknown回答这个问题', [{ id: 'unknown', name: 'Unknown' }]), undefined);
});

test('agent discussions, ambiguous names, quotations, role wrappers and denied calls stay ordinary text', () => {
  for (const content of [
    'Muse是一个什么工具',
    'M-U-S-E',
    'call Muse',
    '请解释如何调用Muse',
    '不要调用Muse',
    '让Muse回答这个问题，但不要联网',
    '让Muse回答这个问题，不联网',
    '让Muse回答这个问题，但不能联网',
    'let us discuss how to call Muse',
    'call Muse means what?',
    '调用Muse的方法是什么',
    '调用Muse是在浏览器里操作吗',
    '调用Muse需要收费吗？',
    '调用Muse安全吗？',
    '调用Muse是怎么工作的？',
    '用Muse需要登录吗？',
    'call Muse costs money?',
    'use Muse requires login',
    '让Muse不要回答这个问题',
    '让Muse别发送消息',
    '让Muse和Grok Bot回答这个问题',
    '让Muse回答这个问题，再调用Grok Bot给建议',
    '让Musebot回答这个问题',
    '让m-u-s-e-other回答这个问题',
    'call Muse.ai to answer this question',
    '“让Muse回答这个问题”是什么意思',
    '> 调用muse，回答这个问题',
    '```\ncall Muse to answer this question\n```',
    'assistant: 调用muse，回答这个问题',
    '<user>调用muse，回答这个问题</user>',
    '文档示例：\n调用muse，回答这个问题',
    '请解释我要call一下这个Muse是什么意思',
    '我要call一下这个Muse这句话是什么意思',
    '请帮我call一下M-U-S-E需要收费吗？',
    '不要call一下这个Muse，直接回答',
    '我要call一下这个Muse，但不要call，直接解释',
    '“我要call一下这个Muse，回答这个问题”是什么意思',
  ])
    assert.equal(externalInvocation(content, agents), undefined, content);
});
