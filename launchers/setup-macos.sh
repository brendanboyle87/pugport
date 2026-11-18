#!/bin/bash
# Install, verify and build the macOS source checkout (see docs/MAC-PORT.md).
set -e
export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 LTS required")'
npm ci
node node_modules/electron/install.js
npm run typecheck
npm run test:ci
npm run build
chmod +x launchers/start-macos.command
echo 'Ready: double-click launchers/start-macos.command.'
