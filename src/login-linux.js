// Start at login on Linux. Electron's own login items are Windows and macOS only, so Wilfred writes
// an XDG autostart entry that runs start-wilfred.sh (which starts him through XWayland).

const fs = require('node:fs');
const path = require('node:path');

/** Where the entry goes: $XDG_CONFIG_HOME/autostart (when set to an absolute path), else ~/.config/autostart. */
function autostartPath(home, env = {}) {
  const config = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(config, 'autostart', 'wilfred.desktop');
}

// The same escaping as platform.js's execArg (this file may load only Node's own modules): a string
// value with backslashes and line breaks escaped, and Exec's quoting inside it.
function desktopString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
function execArg(s) {
  return desktopString(`"${String(s).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`);
}

/**
 * The autostart entry for the launcher at `launcherPath`. Hidden from menus; started a few
 * seconds after login so a desktop's compositor is up first (without one his window is black).
 */
function autostartEntry(launcherPath) {
  return `[Desktop Entry]
Type=Application
Name=Wilfred
Exec=${execArg(launcherPath)}
TryExec=${desktopString(launcherPath)}
Icon=wilfred
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
`;
}

/**
 * Whether Wilfred starts at login: his entry is there and nobody switched it off in the desktop's
 * own startup settings (which write Hidden=true or X-GNOME-Autostart-enabled=false).
 */
function isOn(home, env = {}, fsImpl = fs) {
  let text;
  try {
    text = fsImpl.readFileSync(autostartPath(home, env), 'utf8');
  } catch {
    return false;
  }
  return !/^\s*Hidden\s*=\s*true\s*$/im.test(text) && !/^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text);
}

/** Adds or removes the autostart entry. It takes effect at the next login. */
function setOn(on, { home, env = {}, launcher }, fsImpl = fs) {
  const file = autostartPath(home, env);
  if (!on) {
    fsImpl.rmSync(file, { force: true });
    return;
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, autostartEntry(launcher));
}

module.exports = { autostartPath, autostartEntry, isOn, setOn };
