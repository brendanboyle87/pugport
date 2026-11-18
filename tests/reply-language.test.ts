import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyLanguage } from '../src/server/workspace.ts';
import { slackPrompt } from '../src/server/slack-context.ts';

test('executor explanations follow the UI language regardless of message, paths, code or links', () => {
  for (const message of [
    '现在可以处理了吗',
    'Can you sort these folders now?',
    'このファイルを整理して',
    '파일을 정리해 주세요',
    'Fix the typo in 说明.md please',
    '看看 `npm run build` 的报错',
    'https://example.com/a/b',
  ]) {
    assert.match(replyLanguage(message, 'zh-CN'), /必须用简体中文写/, message);
    assert.match(replyLanguage(message, 'en'), /必须用英语写/, message);
    assert.match(replyLanguage(message, 'zh-TW'), /必须用.*繁体.*写/, message);
    assert.match(replyLanguage(message), /必须用简体中文写/, message);
  }
});

test('UI guidance keeps explanations in the UI language and outgoing drafts in the original or recipient language', () => {
  const expected =
    '回复语言：按照应用界面语言，面向用户的解释、分析和提问必须用简体中文写（文件名、路径、代码、命令保持原样）；不要因上下文或工具输出改用其他语言。用户要发送或发布给他人的文本（回复邮件、消息、帖子、评论、求职信等）按原始材料或收件人的语言起草，除非用户指定草稿语言；收件人不明确时按原始消息的语言，英文邮件或截图应给出英文草稿。';
  for (const message of [
    '这封英文招聘邮件怎么回复？',
    'Help me reply to this English email screenshot.',
    'Draft a message, post, comment or cover letter.',
    '帮我写一封法语求职信。',
    'Reply to me in this Slack thread.',
  ]) {
    assert.equal(replyLanguage(message, 'zh-CN'), expected);
    assert.equal(replyLanguage(message, 'en'), expected.replace('简体中文', '英语'));
    assert.equal(replyLanguage(message, 'zh-TW'), expected.replace('简体中文', '繁体中文'));
  }
});

test('explicit and inherited language requests retain the exact whole-reply instruction', () => {
  const expected =
    '回复语言：用户明确要求，整条回复必须用英语写（文件名、路径、代码、命令保持原样）；不要因上下文或工具输出改用其他语言。';
  for (const locale of ['zh-CN', 'en', 'zh-TW'] as const) {
    assert.equal(replyLanguage('用英文回复', locale), expected);
    assert.equal(replyLanguage('reply in English', locale), expected);
    assert.equal(replyLanguage('Continue the reply.', locale, '英语'), expected);
  }
});

test('only explicit reply language requests override UI language, preserving code and paths', () => {
  for (const message of ['用英文回答', '请以英语回复', 'Answer in English please', 'respond in English'])
    assert.match(replyLanguage(message, 'zh-CN'), /用户明确要求.*必须用英语写/, message);
  for (const message of ['用中文回复', 'answer in Chinese'])
    assert.match(replyLanguage(message, 'en'), /必须用简体中文写/, message);
  for (const message of ['用日语回答', 'reply in Japanese', '日本語で答えて'])
    assert.match(replyLanguage(message, 'en'), /必须用日语写/, message);
  for (const message of ['用韩语回答', 'reply in Korean', '한국어로 답해주세요'])
    assert.match(replyLanguage(message, 'en'), /必须用韩语写/, message);
  assert.match(replyLanguage('reply in Traditional Chinese', 'en'), /必须用繁体中文写/);
  assert.match(replyLanguage('用英语回复，然后用中文回答', 'en'), /必须用简体中文写/);
  for (const message of [
    '看 `answer in English` 的代码',
    'https://example.com/answer/in/English',
    'English README',
    'Analyze “reply in English”',
    '分析「用英文回答」这句话',
    'Explain this sentence: "answer in English"',
    '> reply in English\nExplain the quote above.',
    '~~~\nreply in English\n~~~',
    '不要用英文回答',
    "Don't answer in English",
  ])
    assert.match(replyLanguage(message), /必须用简体中文写/, message);
  assert.match(replyLanguage('用英文回答'), /文件名、路径、代码、命令保持原样/);
});

test('Slack thread replies address the user and defer to the shared language guidance', () => {
  for (const continued of [false, true]) {
    assert.equal(
      slackPrompt({ requester: 'Synthetic user', request: 'Explain this email.', context: '', continued }),
      (continued ? 'Follow-up request' : 'Request') +
        ' sent from Slack by Synthetic user. Your reply is addressed to the user and posted back into Slack as plain text; follow the reply-language guidance.\n\nRequest from Synthetic user:\nExplain this email.',
    );
  }
});
