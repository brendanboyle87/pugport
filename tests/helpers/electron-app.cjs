'use strict';
const { join } = require('node:path');

const electronLoader = join(__dirname, 'electron-loader.cjs');

/**
 * Arguments for the Electron binary that start `app` (a main-process script) through electron-loader.cjs, so a
 * missing or broken app prints its error and exits instead of opening a dialog on the desktop.
 */
function electronArgs(app, ...rest) {
  return [electronLoader, app, ...rest];
}

module.exports = { electronArgs, electronLoader };
