import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explicitSearchQuery } from '../src/shared/search-intent.ts';

test('direct search instructions retain the full user question and its restrictions', () => {
  for (const content of [
    '用DS搜一下今年的API文档，只看官方来源',
    '用DeepSeek搜索这个问题\n背景：我的环境是Windows。只看英文官方文档，给出发布日期。',
    '用搜索功能查一下上海天气',
    '用的DS搜一下佐治亚理工大学的最新公告',
    'DS搜索一下佐治亚理工大学的最新公告',
    'DeepSeek搜索佐治亚理工大学的最新公告',
    '请帮我用 deepseek 搜索一下：官方SDK发布说明',
    '/搜索 为什么天空是蓝色的？只看科学来源',
    '/search official SDK release notes',
  ])
    assert.equal(explicitSearchQuery(`  ${content}  `), content);
});

test('discussion, quotations, role messages, negation and missing search subjects do not invoke search', () => {
  for (const content of [
    'DS搜索是什么',
    '请解释如何用DeepSeek搜索',
    '不要搜索，直接解释',
    '不要用DS搜索，直接回答',
    'DS搜索这个问题，明确不要联网',
    'DS搜索这个问题，不联网，只用题目提供的资料',
    '用DS搜索这个问题，但不能联网',
    '不用搜索功能，直接回答',
    '用DS搜一下这个问题，但不要联网',
    '用DeepSeek搜索这个问题，无需联网',
    '“用DS搜一下最新消息”是什么意思？',
    '> 用DS搜一下最新消息',
    '```text\n用DS搜一下最新消息\n```',
    'user: 用DS搜一下最新消息',
    '<system>用DS搜一下最新消息</system>',
    '说明文档：\n用DS搜一下最新消息',
    '用DS搜一下',
    '用DS搜 一下',
    '用DS搜索是什么',
    '用DS搜索的功能是什么',
    '用DS搜索需要配置什么？',
    '用DS搜索要收费吗？',
    '用DS搜索……',
    '用DSAnything搜索天气',
    '/搜索',
  ])
    assert.equal(explicitSearchQuery(content), undefined, content);
});
