import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { electronModule } from './helpers/electron-harness.ts';

test('Mac menu-bar icons use system contrast independently of the application theme', async () => {
  for (const platform of ['darwin', 'win32']) {
    const templates: boolean[] = [];
    const image = { setTemplateImage: (value: boolean) => templates.push(value) };
    const module = await electronModule(
      'src/electron/tray.ts',
      {
        nativeImage: { createFromPath: () => image },
        nativeTheme: { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: false },
      },
      { process: { platform, env: {} } },
    );
    assert.equal(module.trayIcon(resolve('assets/icons')), image);
    assert.equal(module.trayIcon(resolve('assets/icons'), true), image);
    assert.deepEqual(templates, platform === 'darwin' ? [true, true] : []);
  }
});
