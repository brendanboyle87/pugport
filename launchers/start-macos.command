#!/bin/bash
# Launch the source checkout. Finder does not inherit the Terminal's Homebrew PATH.
set -e
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'Install Node.js 24 LTS, then run bash launchers/setup-macos.sh.'
  exit 1
fi
if [ ! -f node_modules/electron/cli.js ] || [ ! -f dist/electron/main.cjs ]; then
  echo 'Run bash launchers/setup-macos.sh first to install and build PugPort.'
  exit 1
fi
exec node node_modules/electron/cli.js . "$@"
