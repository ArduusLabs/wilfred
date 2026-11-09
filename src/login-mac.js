// Start at login on a Mac. Electron's own login item opens the bare Electron app there, without
// Wilfred's folder, so Wilfred registers a per-user LaunchAgent that runs Electron on his folder (or,
// for a downloaded Wilfred.app, just the app's own executable, which knows where its folder is).

const fs = require('node:fs');
const path = require('node:path');

const LABEL = 'com.arduuslabs.wilfred.login';
// A LaunchAgent doesn't see your shell's exports, so these are copied into it when they are set.
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'WILFRED_SESSIONS_DIR'];

function agentPath(home) {
  return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** Where launchd writes Wilfred's output when it starts him (otherwise it is lost). */
function logPath(home) {
  return path.join(home, 'Library', 'Logs', 'Wilfred', 'launchd.log');
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unxml(s) {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** The variables from ENV_KEYS that are set (non-empty) in `env`. */
function agentEnv(env = {}) {
  const out = {};
  for (const key of ENV_KEYS) if (typeof env[key] === 'string' && env[key]) out[key] = env[key];
  return out;
}

/** The command the agent runs, as the plist's lines: Electron and the folder, or the app alone. */
function programArguments(execPath, appPath, packaged) {
  return [execPath, ...(packaged ? [] : [appPath])].map((a) => `    <string>${xml(a)}</string>`).join('\n');
}

/**
 * The LaunchAgent that starts `execPath appPath` (packaged: `execPath` alone) when you log in: only
 * in a graphical session, with an app's priority, its output in ~/Library/Logs/Wilfred. Never
 * KeepAlive: quitting Wilfred from the tray must keep him quit.
 */
function agentPlist(execPath, appPath, { log = '', env = {}, packaged = false } = {}) {
  const vars = Object.entries(agentEnv(env));
  const envBlock = vars.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${vars.map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>\n`).join('')}  </dict>
`
    : '';
  const logBlock = log
    ? `  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments(execPath, appPath, packaged)}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>WorkingDirectory</key>
  <string>${xml(appPath)}</string>
${logBlock}${envBlock}</dict>
</plist>
`;
}

/** The variables an existing agent file already carries (kept when it is rewritten). */
function envInPlist(text) {
  const out = {};
  for (const key of ENV_KEYS) {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    if (m) out[key] = unxml(m[1]);
  }
  return out;
}

function isOn(home, fsImpl = fs) {
  return fsImpl.existsSync(agentPath(home));
}

// launchd skips an agent that others can write to, so the file is 0644 whatever the umask.
function writeAgent(file, text, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, text, { mode: 0o644 });
  try {
    fsImpl.chmodSync(file, 0o644);
  } catch {
    // Not every file system keeps modes; the write's own mode stands.
  }
}

function plistFor({ home, execPath, appPath, env, packaged }) {
  return agentPlist(execPath, appPath, { log: logPath(home), env, packaged });
}

/** Adds or removes the LaunchAgent. It takes effect at the next login. */
function setOn(on, { home, execPath, appPath, env = {}, packaged = false }, fsImpl = fs) {
  const file = agentPath(home);
  if (!on) {
    fsImpl.rmSync(file, { force: true });
    return;
  }
  fsImpl.mkdirSync(path.dirname(logPath(home)), { recursive: true });
  writeAgent(file, plistFor({ home, execPath, appPath, env, packaged }), fsImpl);
}

/**
 * At startup: when the agent is there but names another Electron or another folder (the folder
 * was moved, node_modules reinstalled elsewhere, or a checkout's agent meets the downloaded app),
 * it is rewritten for this one, keeping the variables it carried unless this launch has its own.
 * Returns whether it rewrote the file.
 */
function refresh({ home, execPath, appPath, env = {}, packaged = false }, fsImpl = fs) {
  const file = agentPath(home);
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch {
    return false; // off: nothing to refresh
  }
  if (text.includes(`<array>\n${programArguments(execPath, appPath, packaged)}\n  </array>`)) return false;
  setOn(true, { home, execPath, appPath, packaged, env: { ...envInPlist(text), ...agentEnv(env) } }, fsImpl);
  return true;
}

module.exports = { LABEL, ENV_KEYS, agentPath, logPath, agentPlist, agentEnv, envInPlist, isOn, setOn, refresh };
