#!/usr/bin/env bash
# Ubuntu 24.04 and later: lets Wilfred's Electron use Chromium's sandbox, by installing an AppArmor
# profile for this folder's Electron (Ubuntu's own recommended way). Shows the profile and asks
# before it changes anything; it needs your password once, for sudo.
set -eu
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1

# A downloaded Wilfred: this folder is wilfred/resources/app, and the profile names his own executable.
if [ "$(basename "$(dirname "$PWD")")" = resources ] && [ -x ../../wilfred ]; then
  BINARY=../../wilfred
else
  # A checkout. Electron 42+ fetches its binary on first use; fetch it now so the profile can name it.
  if [ ! -e node_modules/electron/dist/electron ]; then
    node node_modules/electron/install.js || { echo "Wilfred: run 'npm install' in this folder first." >&2; exit 1; }
  fi
  BINARY=node_modules/electron/dist/electron
fi
# AppArmor matches the real file, so follow any symlinks (node_modules may be one).
ELECTRON="$(readlink -f "$BINARY")"
case "$ELECTRON" in
  *'"'*) echo "Wilfred: the folder's path contains a double quote, which an AppArmor profile can't name." >&2; exit 1 ;;
esac

PROFILE=/etc/apparmor.d/wilfred-electron
TEXT="abi <abi/4.0>,
include <tunables/global>
profile wilfred-electron \"$ELECTRON\" flags=(unconfined) {
  userns,
  include if exists <local/wilfred-electron>
}"

echo "This writes $PROFILE with:"
echo
printf '%s\n' "$TEXT"
echo
echo "and loads it with: sudo apparmor_parser -r $PROFILE"
printf 'Continue? [y/N] '
read -r answer
case "$answer" in
  y | Y | yes | YES) ;;
  *) echo "Nothing changed."; exit 1 ;;
esac

printf '%s\n' "$TEXT" | sudo tee "$PROFILE" >/dev/null
sudo apparmor_parser -r "$PROFILE"
echo "Done. Start Wilfred again with $PWD/start-wilfred.sh"
