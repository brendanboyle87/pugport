import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

// Uses the real picture and text models when they are set up (npm run setup:image-search); CPU only, so the
// result does not depend on the graphics card.
const root = resolve(import.meta.dirname, '..');
const models = existsSync(join(root, '.runtime', 'image-search', 'ocr', 'rec.onnx'));
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'image-ocr-test-')));
// Expose only the read-only local models. The real app root also includes Everything, whose startup/index
// state must not affect these synthetic screenshots or launch a hidden process during the test.
const app = join(scratch, 'app');
mkdirSync(join(app, '.runtime'), { recursive: true });
if (models)
  symlinkSync(
    join(root, '.runtime', 'image-search'),
    join(app, '.runtime', 'image-search'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
process.env.COMBORUNNER_IMAGE_INDEX_DIR = join(scratch, 'index');
process.env.COMBORUNNER_IMAGE_BACKGROUND = '0';
process.env.COMBORUNNER_IMAGE_GPU = '0';
test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** A screenshot-like picture: dark text lines on a light page. */
async function screenshot(path: string, lines: string[]) {
  const rows = lines
    .map(
      (line, index) =>
        `<text x="40" y="${80 + index * 56}" font-size="32" font-family="Microsoft YaHei, SimHei, Arial, sans-serif" fill="#222">${line}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${120 + lines.length * 56}"><rect width="100%" height="100%" fill="#f7f7f8"/><rect x="0" y="0" width="1100" height="36" fill="#2b5fd9"/>${rows}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

test(
  'screenshots are found by the words in them, whatever the spacing and case',
  { skip: !models && 'models not set up' },
  async () => {
    const { findSimilarImages, foregroundBudget, resetImageIndex } = await import('../src/server/image-search.ts');
    const { stopMatchWorker } = await import('../src/server/image-match.ts');
    resetImageIndex();
    const folder = join(scratch, 'shots');
    mkdirSync(folder, { recursive: true });
    await screenshot(join(folder, 'order.png'), [
      '订单详情',
      '订单号 2025-0917-8841',
      '支付成功，预计明天送达',
      'Total: 128.00',
    ]);
    await screenshot(join(folder, 'settings.png'), ['系统设置', '显示与亮度', '通知与提醒', 'Privacy and security']);
    await screenshot(join(folder, 'chat.png'), ['张三：明天下午三点开会', '李四：好的，我带上周报', 'Meeting room B2']);
    const saved = { ...foregroundBudget.alone };
    foregroundBudget.alone = { analyze: 120_000, match: 120_000 };
    try {
      const order = await findSimilarImages({ contains: '订单号 2025', folders: [folder] }, app);
      assert.match(order, /图里有“订单号 2025”字样的图片（1）：\n- .*order\.png —— “订单号/);
      // Spaces and case do not matter: OCR runs words together.
      const english = await findSimilarImages({ contains: 'PRIVACY and Security', folders: [folder] }, app);
      assert.match(english, /settings\.png/);
      assert.doesNotMatch(english, /order\.png|chat\.png/);
      const none = await findSimilarImages({ contains: '这句话不存在', folders: [folder] }, app);
      assert.match(none, /（0）：\n（没有找到）/);
    } finally {
      foregroundBudget.alone = saved;
      stopMatchWorker();
    }
  },
);
