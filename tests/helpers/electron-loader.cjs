'use strict';
// Tests start every Electron app through this file (electronArgs in electron-app.cjs). Electron's built-in default
// app opens a modal "Error launching app" box on the owner's desktop when the app it is given is missing or throws
// while loading, and Electron opens another box for an uncaught main-process error. Here each is printed and the
// process exits with code 1 instead, so a broken test can never leave a window behind.
let failed = false;
let app;
function fail(error) {
  if (failed) return;
  failed = true;
  const exit = () => (app ? app.exit(1) : process.exit(1));
  setTimeout(exit, 1000);
  process.stderr.write(`electron-loader: ${error?.stack ?? error}\n`, exit);
}
process.on('uncaughtException', fail);
// 'electron/main', not 'electron': offscreen-electron.cjs, preloaded through NODE_OPTIONS from this same folder,
// resolves 'electron' before Electron serves its API, and Node then hands this file the npm package's path instead.
const electron = require('electron/main');
app = electron.app;
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
// An app (or the code it tests) may still call the error box itself; a test that wants to see it replaces this.
electron.dialog.showErrorBox = (title, content) => fail(`${title}\n${content}`);
// The app sees the arguments it would get if Electron had started it directly: [electron, app, ...rest].
process.argv.splice(1, 1);
const target = process.argv[1];
try {
  if (!target) throw new Error('no app given');
  const path = resolve(target);
  const file = require.resolve(path);
  // As Electron's default app does: a folder's package.json names the app, and the app path is the folder (or the
  // script's own folder), not this loader's.
  const manifest = join(path, 'package.json');
  if (existsSync(manifest)) {
    const { name, productName, version } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (version) app.setVersion(version);
    if (productName || name) app.name = productName || name;
  }
  app.setAppPath(existsSync(manifest) ? path : dirname(file));
  require(file);
} catch (error) {
  fail(error);
}
