const assert = require('node:assert/strict');

module.exports = async ({ win, evaluate, frame, click, category, choose, fits, screenshot, english }) => {
  await evaluate(`window.fixture.state.settings.maxConcurrentRuns=0;window.broadcast();window.english()`);
  await frame();
  const openCategory = async (id) => {
    if (
      await evaluate(
        "!!document.querySelector('.settings-back') && document.querySelector('.settings-back').getClientRects().length>0",
      )
    )
      await click('.settings-back');
    await category(id);
  };
  for (const width of [1280, 390]) {
    win.setContentSize(width, 800);
    await frame();
    await evaluate("document.documentElement.dataset.theme='dark'");
    for (const id of ['general', 'conversation', 'routing', 'permissions', 'advanced', 'devices']) {
      await openCategory(id);
      await fits();
      const prefix = `dark-${id}-${width}`;
      if (id === 'general') {
        assert.equal(
          await evaluate(`(()=>{
          const s=document.querySelector('select[aria-label="${english['任务完成通知']}"]');
          const ctx=document.createElement('canvas').getContext('2d'), style=getComputedStyle(s);ctx.font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
          return [...s.options].every(o=>ctx.measureText(o.textContent).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)<=s.getBoundingClientRect().width);
        })()`),
          true,
          'notification labels fit',
        );
        assert.deepEqual(
          await evaluate(
            `Array.from(document.querySelector('select[aria-label="${english['任务完成通知']}"]').options,o=>o.value)`,
          ),
          ['background', 'always', 'never'],
        );
      }
      if (id === 'conversation') {
        assert.equal(await evaluate("document.querySelectorAll('.settings-section small').length"), 2);
        assert.equal(
          await evaluate(
            `document.querySelector('input[aria-label="${english['显示自动回复的执行器、模型和强度']}"]').checked`,
          ),
          true,
        );
      }
      if (id === 'routing') {
        assert.equal(
          await evaluate(
            `(()=>{const cards=[...document.querySelectorAll('.goal-picker button')];return new Set(cards.map(c=>c.getBoundingClientRect().height)).size===1})()`,
          ),
          true,
        );
        assert.equal(
          await evaluate("getComputedStyle(document.querySelector('.routing-profiles-settings')).borderTopWidth"),
          '0px',
        );
        assert.equal(await evaluate(`document.querySelectorAll('#settings-laya-sharing h3').length`), 0);
        for (const label of ['默认调度方式', '账号使用顺序'])
          assert.equal(
            await evaluate(`!!document.querySelector('select[aria-label="${english[label]}"]').closest('details')`),
            false,
          );
      }
      if (id === 'permissions') {
        assert.equal(await evaluate("document.querySelectorAll('#settings-sandbox select').length"), 0);
        assert.equal(await evaluate("document.querySelector('#settings-sandbox details').open"), false);
        assert.ok(
          await evaluate(
            "document.querySelector('.settings-content').textContent.includes('PugPort never generates sexual content involving minors.')",
          ),
        );
      }
      if (id === 'advanced') {
        assert.equal(
          await evaluate(`document.querySelector('input[aria-label="${english['默认工作文件夹']}"]').value`),
          'C:/Synthetic',
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('Concurrent tasks:')).parentElement.open",
          ),
          false,
        );
      }
      if (id === 'devices')
        assert.equal(
          await evaluate("document.querySelector('.settings-content').textContent.includes('write status unknown')"),
          false,
        );
      await screenshot(prefix + '.png');
      if (['general', 'routing', 'advanced'].includes(id)) {
        await evaluate("document.querySelector('.management-main').scrollTop=99999");
        await screenshot(prefix + '-bottom.png');
      }
    }
    await openCategory('conversation');
    await evaluate("document.documentElement.dataset.theme='light'");
    await frame();
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    await screenshot(`light-conversation-${width}.png`);
  }
  win.setContentSize(1280, 800);
  await evaluate(`document.documentElement.dataset.theme='dark';
    window.fixture.state.sandboxStatus={available:true,reason:'ready',message:'Ready',sdkVersion:'1.0.1'};
    window.fixture.state.settings.sandbox={pi:'learn',claude:'off',codex:'enforce'};
    window.broadcast();`);
  await openCategory('permissions');
  await frame();
  assert.equal(await evaluate(`document.querySelector('select[aria-label="${english['学习模式']}"]').value`), 'custom');
  await screenshot('dark-permissions-ready.png');
  await choose(english['学习模式'], 'learn');
  assert.deepEqual(await evaluate('window.fixture.state.settings.sandbox'), {
    pi: 'learn',
    claude: 'learn',
    codex: 'enforce',
    grok: 'learn',
    cursor: 'learn',
  });
  await click('#settings-sandbox details summary');
  await choose('Claude', 'off');
  assert.equal(
    await evaluate(`document.querySelector('select[aria-label="${english['学习模式']}"]').value`),
    'learn',
    'cancelled native permission change is restored',
  );
  await evaluate(
    `window.comboRunnerDesktop.changePermission=async change=>{window.permissionCalls.push(change);Object.assign(window.fixture.state.settings,change.patch);return true;};void 0`,
  );
  await choose('Claude', 'off');
  assert.equal(await evaluate(`document.querySelector('select[aria-label="${english['学习模式']}"]').value`), 'custom');
  await click('#settings-sandbox details:last-child summary');
  await frame();
  assert.ok(await evaluate("window.permissionCalls.some(c=>c.kind==='settings' && c.patch.sandbox?.claude==='off')"));
  await evaluate("document.querySelector('.management-main').scrollTop=99999");
  await screenshot('dark-permissions-expanded.png');
};
