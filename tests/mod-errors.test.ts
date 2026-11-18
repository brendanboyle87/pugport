import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyModError } from '../src/ui/mod-errors';

test('Mod errors map the eight approved cases and retain only copyable diagnostic details', () => {
  const cases: [unknown, Parameters<typeof friendlyModError>[1], string][] = [
    [{ status: 400, message: 'bad manifest' }, undefined, '这个 Mod 的文件有问题，暂时不能加载。等作者更新后再试。'],
    [new Error('[{"code":"invalid_type"}]'), undefined, '这个 Mod 的文件有问题，暂时不能加载。等作者更新后再试。'],
    [new Error('sha256 mismatch'), 'source', '下载的文件和来源记录对不上，为了安全没有加载。'],
    [new Error('size mismatch'), 'source', '下载的文件和来源记录对不上，为了安全没有加载。'],
    [{ status: 503, message: 'upstream failure' }, 'source', '连不上 Mod 来源。检查网络后重试。'],
    [new TypeError('Failed to fetch'), undefined, '连不上 Mod 来源。检查网络后重试。'],
    [{ code: 'E_UNAVAILABLE', message: 'source offline' }, 'source', '连不上 Mod 来源。检查网络后重试。'],
    [{ compatible: false }, undefined, '需要更新 PugPort 才能使用这个 Mod。'],
    [new Error('hostVersion mismatch'), undefined, '需要更新 PugPort 才能使用这个 Mod。'],
    [new Error('来源已更新，请重新打开这个 Mod。'), 'source', '来源已更新，请重新打开这个 Mod。'],
    [new Error('正在更新来源，请稍后重试。'), 'source', '正在更新来源，请稍后重试。'],
    [new Error('private navigation detail'), 'open', '没能打开这个 Mod，请重试。'],
    [new Error('private catalog detail'), 'list', '暂时读不到 Mods 列表。'],
    [new Error('private failure detail'), undefined, '没能完成，请重试。'],
  ];
  for (const [failure, context, text] of cases) {
    const result = friendlyModError(failure, context);
    assert.equal(result.text, text);
    assert.equal(result.detail, (failure as { message?: string }).message ?? '');
    assert.equal(friendlyModError(result.text).text, result.text);
  }
});

test('source integrity errors win over HTTP 400 and unrelated size errors stay generic', () => {
  assert.match(friendlyModError({ status: 400, message: 'sha256 mismatch' }, 'source').text, /对不上/);
  assert.match(friendlyModError({ status: 400, message: 'Mod 文件校验失败，未安装。' }, 'source').text, /对不上/);
  assert.match(friendlyModError('GitHub Mod 源暂时无法访问，请稍后重试。', 'source').text, /连不上/);
  assert.equal(friendlyModError(new Error('size of UI unavailable')).text, '没能完成，请重试。');
  assert.equal(friendlyModError(null).text, '没能完成，请重试。');
});
