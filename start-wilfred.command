#!/bin/sh
# Starts Wilfred on a Mac. macOS starts him on his own, so this Terminal window can close.
# Running it again while he's hidden brings him back.
cd "$(dirname "$0")" || exit 1
APP="$PWD/node_modules/electron/dist/Electron.app"
# Electron 42+ fetches its app on first use rather than at npm install: fetch it now if missing.
if [ ! -d "$APP" ]; then
  node node_modules/electron/install.js || { echo "Run npm install first"; exit 1; }
fi
open -n -a "$APP" --args "$PWD" "$@"
