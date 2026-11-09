#!/usr/bin/env bash
# Starts Wilfred on Linux, detached from this terminal (which you can close).
# Running it again while he's hidden brings him back. --foreground keeps him attached, with his log here.
set -u
cd "$(dirname "$(readlink -f "$0")")" || exit 1
# A downloaded Wilfred keeps this script in wilfred/resources/app, and his own executable two folders
# up, which loads the app by itself. A checkout runs its Electron on this folder.
if [ "$(basename "$(dirname "$PWD")")" = resources ] && [ -x ../../wilfred ]; then
  ELECTRON=../../wilfred
  BINARY=../../wilfred
  APP=()
else
  ELECTRON=./node_modules/.bin/electron
  BINARY=node_modules/electron/dist/electron
  APP=(.)
  if [ ! -x "$ELECTRON" ]; then echo "Wilfred: run 'npm install' in this folder first." >&2; exit 1; fi
  # Electron fetches its program on first use rather than at npm install: fetch it now if missing,
  # so the sandbox check below looks at a file that is there.
  if [ ! -x "$BINARY" ]; then node node_modules/electron/install.js || { echo "Wilfred: Electron's program could not be fetched." >&2; exit 1; }; fi
fi
if [ "$(id -u)" = 0 ]; then echo "Wilfred: don't run me as root." >&2; exit 1; fi

# Ubuntu 24.04 and later block the sandbox Chromium uses unless the app has an AppArmor profile.
# Wilfred never runs without his sandbox, so say how to add the profile instead of failing obscurely.
# The profile names one executable: a moved folder, or a download after a checkout, needs it again.
RESTRICT=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [ "$(cat "$RESTRICT" 2>/dev/null)" = 1 ] && ! grep -qF "\"$(readlink -f "$BINARY")\"" /etc/apparmor.d/wilfred-electron 2>/dev/null; then
  echo "Wilfred: Ubuntu 24.04 and later block the sandbox Wilfred's Chromium engine uses, unless the app" >&2
  echo "has an AppArmor profile. Wilfred won't run without its sandbox. Run this once (it asks for your" >&2
  echo "password and shows exactly what it installs), then start Wilfred again:" >&2
  echo "  $PWD/tools/linux-apparmor.sh" >&2
  exit 1
fi

# Wilfred needs to place himself and stay on top, which Wayland doesn't allow apps to do.
# Run him through XWayland unless you opt out with WILFRED_WAYLAND=1.
PLATFORM=--ozone-platform=x11
[ "${WILFRED_WAYLAND:-0}" = 1 ] && PLATFORM=--ozone-platform=wayland
# (The odd expansion of APP is what keeps an empty list working in older bash with set -u.)
if [ "${1:-}" = "--foreground" ]; then shift; exec "$ELECTRON" ${APP[@]+"${APP[@]}"} "$PLATFORM" "$@"; fi
setsid -f "$ELECTRON" ${APP[@]+"${APP[@]}"} "$PLATFORM" "$@" >/dev/null 2>&1 </dev/null
