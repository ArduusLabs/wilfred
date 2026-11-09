// Mac and Linux support, tested on any machine with fake home folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defaultSessionDirs, appDataRoots } = require('../src/sessions/source');
const mac = require('../src/login-mac');
const linux = require('../src/login-linux');
const p = require('../src/platform');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-plat-'));
function sessionsUnder(base) {
  const org = path.join(base, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  return org;
}

test('app data folders per platform', () => {
  assert.deepEqual(appDataRoots({ LOCALAPPDATA: 'L', APPDATA: 'R' }, 'win32', 'H'), [path.join('L', 'Claude-Data'), path.join('L', 'Claude'), path.join('R', 'Claude')]);
  assert.deepEqual(appDataRoots({}, 'win32', 'H'), []);
  assert.deepEqual(appDataRoots({}, 'darwin', '/Users/me'), [
    path.join('/Users/me', 'Library', 'Application Support', 'Claude'),
    path.join('/Users/me', 'Library', 'Application Support', 'Claude-Data'),
  ]);
  assert.deepEqual(appDataRoots({}, 'linux', '/home/me'), [path.join('/home/me', '.config', 'Claude'), path.join('/home/me', '.config', 'Claude-Data')]);
  assert.deepEqual(appDataRoots({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/me')[0], path.join('/x', 'Claude'));
});

test('a Mac keeps sessions directly in the app folder; the Windows Store build one level down', () => {
  const home = tmp();
  const macOrg = sessionsUnder(path.join(home, 'Library', 'Application Support', 'Claude'));
  assert.deepEqual(defaultSessionDirs({}, 'darwin', home), [macOrg]);

  const local = tmp();
  const winOrg = sessionsUnder(path.join(local, 'Claude-Data', 'claude_abc123'));
  assert.deepEqual(defaultSessionDirs({ LOCALAPPDATA: local }, 'win32', 'unused'), [winOrg]);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(local, { recursive: true, force: true });
});

test('WILFRED_SESSIONS_DIR points straight at the sessions folder', () => {
  const dir = tmp();
  const org = sessionsUnder(dir);
  assert.deepEqual(defaultSessionDirs({ WILFRED_SESSIONS_DIR: path.join(dir, 'claude-code-sessions') }, 'darwin', '/nowhere'), [org]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- macOS LaunchAgent ----

test('the Mac LaunchAgent runs Electron on Wilfred\'s folder at login, with paths escaped', () => {
  const plist = mac.agentPlist('/Apps/Electron.app/Contents/MacOS/Electron', '/Users/me/R&D <wilfred>');
  assert.match(plist, /<string>com\.arduuslabs\.wilfred\.login<\/string>/);
  assert.match(plist, /<string>\/Apps\/Electron\.app\/Contents\/MacOS\/Electron<\/string>\s*<string>\/Users\/me\/R&amp;D &lt;wilfred&gt;<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.equal(mac.agentPath('/Users/me'), path.join('/Users/me', 'Library', 'LaunchAgents', 'com.arduuslabs.wilfred.login.plist'));
});

test('a downloaded Wilfred.app\'s LaunchAgent runs the app\'s executable alone, and a checkout\'s agent is rewritten for it', () => {
  const exe = '/Applications/Wilfred.app/Contents/MacOS/Wilfred';
  const app = '/Applications/Wilfred.app/Contents/Resources/app';
  const plist = mac.agentPlist(exe, app, { packaged: true });
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Applications\/Wilfred\.app\/Contents\/MacOS\/Wilfred<\/string>\s*<\/array>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Applications\/Wilfred\.app\/Contents\/Resources\/app<\/string>/);
  const home = tmp();
  const now = { home, execPath: exe, appPath: app, packaged: true };
  mac.setOn(true, { home, execPath: '/Users/me/wilfred/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', appPath: '/Users/me/wilfred' });
  assert.equal(mac.refresh(now), true);
  assert.equal(fs.readFileSync(mac.agentPath(home), 'utf8'), mac.agentPlist(exe, app, { packaged: true, log: mac.logPath(home) }));
  assert.equal(mac.refresh(now), false);
  // And back: a checkout meeting the downloaded app's agent puts its folder back in.
  assert.equal(mac.refresh({ ...now, packaged: false }), true);
  assert.match(fs.readFileSync(mac.agentPath(home), 'utf8'), /<string>\/Applications\/Wilfred\.app\/Contents\/MacOS\/Wilfred<\/string>\s*<string>\/Applications\/Wilfred\.app\/Contents\/Resources\/app<\/string>/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the LaunchAgent runs only in the graphical session, as an app, in his folder, and never restarts him', () => {
  const plist = mac.agentPlist('/E', '/Users/me/wilfred');
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/wilfred<\/string>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  // Without a log or variables, neither block appears.
  assert.doesNotMatch(plist, /StandardOutPath|EnvironmentVariables/);
});

test('the LaunchAgent logs to ~/Library/Logs/Wilfred and carries the folders you set in your shell', () => {
  assert.equal(mac.logPath('/Users/me'), path.join('/Users/me', 'Library', 'Logs', 'Wilfred', 'launchd.log'));
  const plist = mac.agentPlist('/E', '/A', {
    log: '/Users/me/Library/Logs/Wilfred/launchd.log',
    env: { CLAUDE_CONFIG_DIR: '/Users/me/.claude&co', WILFRED_SESSIONS_DIR: '', PATH: '/usr/bin' },
  });
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/Wilfred\/launchd\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/Wilfred\/launchd\.log<\/string>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>CLAUDE_CONFIG_DIR<\/key>\s*<string>\/Users\/me\/\.claude&amp;co<\/string>\s*<\/dict>/);
  // Only the two variables Wilfred reads, and only when set.
  assert.doesNotMatch(plist, /WILFRED_SESSIONS_DIR|PATH</);
  assert.deepEqual(mac.agentEnv(), {});
  assert.deepEqual(mac.agentEnv({ CLAUDE_CONFIG_DIR: 3, WILFRED_SESSIONS_DIR: '/s' }), { WILFRED_SESSIONS_DIR: '/s' });
});

test('the variables an agent file carries are read back unescaped', () => {
  const plist = mac.agentPlist('/E', '/A', { env: { CLAUDE_CONFIG_DIR: '/a&b<"c">', WILFRED_SESSIONS_DIR: '/s' } });
  assert.deepEqual(mac.envInPlist(plist), { CLAUDE_CONFIG_DIR: '/a&b<"c">', WILFRED_SESSIONS_DIR: '/s' });
  assert.deepEqual(mac.envInPlist('<plist/>'), {});
});

test('Open at login on a Mac adds and removes the LaunchAgent', () => {
  const home = tmp();
  const opts = { home, execPath: '/E', appPath: '/A"quoted"' };
  assert.equal(mac.isOn(home), false);
  mac.setOn(true, opts);
  assert.equal(mac.isOn(home), true);
  const text = fs.readFileSync(mac.agentPath(home), 'utf8');
  assert.match(text, /<string>\/A&quot;quoted&quot;<\/string>/);
  assert.ok(text.includes(`<string>${path.join(home, 'Library', 'Logs', 'Wilfred', 'launchd.log')}</string>`));
  // The log folder exists for launchd to write into.
  assert.ok(fs.statSync(path.dirname(mac.logPath(home))).isDirectory());
  mac.setOn(false, opts);
  assert.equal(mac.isOn(home), false);
  mac.setOn(false, opts); // already off: fine
  fs.rmSync(home, { recursive: true, force: true });
});

test('the agent file is written 0644 and chmod-ed, and a file system without modes is fine', () => {
  const calls = [];
  const fake = {
    mkdirSync: (d) => calls.push(['mkdir', d]),
    writeFileSync: (f, _t, o) => calls.push(['write', f, o.mode]),
    chmodSync: (f, m) => {
      calls.push(['chmod', f, m]);
      throw new Error('EPERM');
    },
  };
  mac.setOn(true, { home: '/Users/me', execPath: '/E', appPath: '/A' }, fake);
  const file = mac.agentPath('/Users/me');
  assert.deepEqual(calls.filter(([k]) => k !== 'mkdir'), [['write', file, 0o644], ['chmod', file, 0o644]]);
  assert.ok(calls.some(([k, d]) => k === 'mkdir' && d === path.dirname(mac.logPath('/Users/me'))));
});

test('a stale LaunchAgent is rewritten at startup for this folder, keeping its variables', () => {
  const home = tmp();
  const now = { home, execPath: '/new/Electron', appPath: '/Users/me/wilfred' };
  // Off: nothing to do.
  assert.equal(mac.refresh(now), false);
  assert.equal(mac.isOn(home), false);
  // On, for an old folder, carrying a variable this launch doesn't have.
  mac.setOn(true, { home, execPath: '/old/Electron', appPath: '/Users/me/old', env: { CLAUDE_CONFIG_DIR: '/c' } });
  assert.equal(mac.refresh({ ...now, env: { WILFRED_SESSIONS_DIR: '/s' } }), true);
  const text = fs.readFileSync(mac.agentPath(home), 'utf8');
  assert.match(text, /<string>\/new\/Electron<\/string>\s*<string>\/Users\/me\/wilfred<\/string>/);
  assert.deepEqual(mac.envInPlist(text), { CLAUDE_CONFIG_DIR: '/c', WILFRED_SESSIONS_DIR: '/s' });
  // Up to date: left alone.
  assert.equal(mac.refresh(now), false);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- Linux autostart ----

test('the Linux autostart entry lives in $XDG_CONFIG_HOME/autostart, else ~/.config/autostart', () => {
  const dflt = path.join('/home/me', '.config', 'autostart', 'wilfred.desktop');
  assert.equal(linux.autostartPath('/home/me'), dflt);
  assert.equal(linux.autostartPath('/home/me', {}), dflt);
  assert.equal(linux.autostartPath('/home/me', { XDG_CONFIG_HOME: '/cfg' }), path.join('/cfg', 'autostart', 'wilfred.desktop'));
  // Not absolute, empty or not a string: the spec says ignore it.
  assert.equal(linux.autostartPath('/home/me', { XDG_CONFIG_HOME: 'relative' }), dflt);
  assert.equal(linux.autostartPath('/home/me', { XDG_CONFIG_HOME: '' }), dflt);
  assert.equal(linux.autostartPath('/home/me', { XDG_CONFIG_HOME: 7 }), dflt);
});

test('the autostart entry runs start-wilfred.sh, quoted, hidden from menus, a few seconds after login', () => {
  const text = linux.autostartEntry('/home/me/my wilfred/start-wilfred.sh');
  assert.match(text, /^\[Desktop Entry\]\nType=Application\nName=Wilfred\n/);
  assert.match(text, /^Exec="\/home\/me\/my wilfred\/start-wilfred\.sh"$/m);
  assert.match(text, /^TryExec=\/home\/me\/my wilfred\/start-wilfred\.sh$/m);
  assert.match(text, /^NoDisplay=true$/m);
  assert.match(text, /^X-GNOME-Autostart-enabled=true$/m);
  assert.match(text, /^X-GNOME-Autostart-Delay=5$/m);
  assert.match(text, /^Terminal=false$/m);
});

test('the desktop-entry escaping is the same in the autostart entry and the launcher entry', () => {
  const odd = '/home/me/a "b" `c` $d %e \\f';
  const exec = linux.autostartEntry(odd).match(/^Exec=(.*)$/m)[1];
  assert.equal(exec, p.execArg(odd));
  // Quoting escapes " ` $ \ with a backslash and % as %%; string escaping then doubles every backslash.
  assert.equal(exec, '"/home/me/a \\\\"b\\\\" \\\\`c\\\\` \\\\$d %%e \\\\\\\\f"');
  const tryExec = linux.autostartEntry('/a\\b\nc\rd\te').match(/^TryExec=(.*)$/m)[1];
  assert.equal(tryExec, String.raw`/a\\b\nc\rd\te`);
  assert.equal(tryExec, p.desktopString('/a\\b\nc\rd\te'));
});

test('start at login on Linux adds and removes the entry, and respects the desktop switching it off', () => {
  const home = tmp();
  const opts = { home, launcher: '/home/me/wilfred/start-wilfred.sh' };
  assert.equal(linux.isOn(home), false);
  linux.setOn(true, opts);
  assert.equal(linux.isOn(home), true);
  assert.equal(linux.isOn(home, {}), true);
  const file = linux.autostartPath(home);
  assert.equal(fs.readFileSync(file, 'utf8'), linux.autostartEntry(opts.launcher));
  // GNOME Tweaks or KDE's autostart settings switched it off.
  fs.writeFileSync(file, linux.autostartEntry(opts.launcher).replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'));
  assert.equal(linux.isOn(home), false);
  fs.writeFileSync(file, `${linux.autostartEntry(opts.launcher)}Hidden=true\n`);
  assert.equal(linux.isOn(home), false);
  linux.setOn(true, opts);
  assert.equal(linux.isOn(home), true);
  linux.setOn(false, opts);
  assert.equal(linux.isOn(home), false);
  linux.setOn(false, opts); // already off: fine
  // XDG_CONFIG_HOME is honoured on the way in and out.
  const cfg = path.join(home, 'cfg');
  linux.setOn(true, { ...opts, env: { XDG_CONFIG_HOME: cfg } });
  assert.ok(fs.existsSync(path.join(cfg, 'autostart', 'wilfred.desktop')));
  assert.equal(linux.isOn(home, { XDG_CONFIG_HOME: cfg }), true);
  assert.equal(linux.isOn(home), false);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- the board window ----

test('the board window is transparent, square-cornered, never white and shown later, on every platform', () => {
  const args = { width: 624, height: 100, iconPath: '/i.png', preload: '/p.js' };
  for (const platform of ['win32', 'darwin', 'linux']) {
    const o = p.boardWindowOptions(platform, args);
    assert.equal(o.width, 624);
    assert.equal(o.height, 100);
    assert.equal(o.icon, '/i.png');
    assert.equal(o.frame, false);
    assert.equal(o.transparent, true);
    assert.equal(o.backgroundColor, '#00000000');
    assert.equal(o.roundedCorners, false);
    assert.equal(o.show, false);
    assert.equal(o.focusable, false);
    assert.equal(o.hasShadow, false);
    assert.equal(o.resizable, false);
    assert.equal(o.alwaysOnTop, true);
    assert.equal(o.skipTaskbar, true);
    assert.deepEqual(o.webPreferences, { preload: '/p.js', contextIsolation: true, nodeIntegration: false, sandbox: true });
  }
});

test('on a Mac the board never goes full screen, stays out of Mission Control and takes the first click', () => {
  const mac = p.boardWindowOptions('darwin', {});
  assert.equal(mac.fullscreenable, false);
  assert.equal(mac.hiddenInMissionControl, true);
  assert.equal(mac.acceptFirstMouse, true);
  for (const platform of ['win32', 'linux']) {
    const o = p.boardWindowOptions(platform, {});
    assert.equal('fullscreenable' in o || 'hiddenInMissionControl' in o || 'acceptFirstMouse' in o, false);
  }
});

// ---- tray, menus, badges ----

test('the tray picture per platform', () => {
  assert.equal(p.trayImageFor('darwin'), 'trayTemplate.png');
  assert.equal(p.trayImageFor('linux'), 'wilfred-32.png');
  assert.equal(p.trayImageFor('win32'), 'tray.png');
  for (const platform of ['darwin', 'linux', 'win32']) assert.ok(fs.existsSync(path.join(ROOT, 'assets', p.trayImageFor(platform))));
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'trayTemplate@2x.png')));
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'wilfred-512.png')));
});

test('the tray: an attached menu on Linux, right-click elsewhere, the Mac\'s Ctrl-click and fixed place', () => {
  assert.deepEqual(p.trayBehaviour('linux'), { attachMenu: true, rightClick: false, ctrlClickMenu: false, ignoreDoubleClick: false, guid: null, title: false });
  assert.deepEqual(p.trayBehaviour('win32'), { attachMenu: false, rightClick: true, ctrlClickMenu: false, ignoreDoubleClick: false, guid: null, title: false });
  assert.deepEqual(p.trayBehaviour('darwin'), { attachMenu: false, rightClick: true, ctrlClickMenu: true, ignoreDoubleClick: true, guid: p.TRAY_GUID, title: true });
  assert.match(p.TRAY_GUID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the Mac application menu keeps the edit, app and window keys and nothing else', () => {
  assert.deepEqual(p.macAppMenu(), [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]);
});

test('the badge counts the sessions that need you or failed', () => {
  const rows = [{ state: 'needs-you' }, { state: 'failed' }, { state: 'working' }, { state: 'idle' }, null, { state: 'needs-you' }];
  assert.equal(p.attentionCount(rows), 3);
  assert.equal(p.attentionCount(), 0);
  assert.equal(p.dockBadge(rows), '3');
  assert.equal(p.dockBadge([{ state: 'new' }]), '');
});

test('where the count shows: the menu bar on a Mac, the Dock only in Dock mode, Linux launcher badges', () => {
  assert.deepEqual(p.badgePlaces('darwin', false), { trayTitle: true, dock: false, count: false });
  assert.deepEqual(p.badgePlaces('darwin', true), { trayTitle: true, dock: true, count: true });
  assert.deepEqual(p.badgePlaces('linux', false), { trayTitle: false, dock: false, count: true });
  assert.deepEqual(p.badgePlaces('linux', true), { trayTitle: false, dock: false, count: true });
  assert.deepEqual(p.badgePlaces('win32', true), { trayTitle: false, dock: false, count: false });
  assert.deepEqual(p.badgePlaces('win32', false), { trayTitle: false, dock: false, count: false });
});

test('Dock hide and show are kept more than a second apart', () => {
  assert.equal(p.dockWait(0, 5000), 0);
  assert.equal(p.dockWait(1000, 1000), p.DOCK_GAP_MS);
  assert.equal(p.dockWait(1000, 1600), p.DOCK_GAP_MS - 600);
  assert.ok(p.DOCK_GAP_MS > 1000);
});

test('per-platform capabilities: unlock events, content protection, what re-asserting re-applies', () => {
  assert.equal(p.unlockEventSupported('win32'), true);
  assert.equal(p.unlockEventSupported('darwin'), true);
  assert.equal(p.unlockEventSupported('linux'), false);
  assert.equal(p.contentProtectionSupported('win32'), true);
  assert.equal(p.contentProtectionSupported('darwin'), true);
  assert.equal(p.contentProtectionSupported('linux'), false);
  assert.deepEqual(p.reassertPlan('win32'), { skipTaskbar: true, allSpaces: false });
  assert.deepEqual(p.reassertPlan('darwin'), { skipTaskbar: true, allSpaces: true });
  assert.deepEqual(p.reassertPlan('linux'), { skipTaskbar: false, allSpaces: false });
});

// ---- Linux: Wayland, commands, shape ----

test('Wilfred restarts through XWayland only on a native Wayland Linux session that has an X server', () => {
  const wayland = { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' };
  assert.equal(p.relaunchForX11({ platform: 'linux', env: wayland, ozoneSwitch: '' }), true);
  assert.equal(p.relaunchForX11({ platform: 'linux', env: wayland, ozoneSwitch: 'wayland' }), true);
  // Already relaunched (or started by start-wilfred.sh): never again.
  assert.equal(p.relaunchForX11({ platform: 'linux', env: wayland, ozoneSwitch: 'x11' }), false);
  assert.equal(p.relaunchForX11({ platform: 'linux', env: { ...wayland, WILFRED_WAYLAND: '1' }, ozoneSwitch: '' }), false);
  assert.equal(p.relaunchForX11({ platform: 'linux', env: { ...wayland, WILFRED_WAYLAND: '0' }, ozoneSwitch: '' }), true);
  assert.equal(p.relaunchForX11({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, ozoneSwitch: '' }), false);
  assert.equal(p.relaunchForX11({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: '' }, ozoneSwitch: '' }), false);
  assert.equal(p.relaunchForX11({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, ozoneSwitch: '' }), false);
  assert.equal(p.relaunchForX11({ platform: 'darwin', env: wayland, ozoneSwitch: '' }), false);
  assert.equal(p.relaunchForX11({ platform: 'win32', env: wayland, ozoneSwitch: '' }), false);
});

test('a launch\'s command comes from Wilfred\'s own flags, the first one winning', () => {
  assert.equal(p.commandIn(['electron', '.', '--wilfred-toggle']), 'toggle');
  assert.equal(p.commandIn(['electron', '.', '--ozone-platform=x11', '--wilfred-settings']), 'settings');
  assert.equal(p.commandIn(['--wilfred-quit', '--wilfred-toggle']), 'quit');
  assert.equal(p.commandIn(['--wilfred-settings', '--wilfred-quit']), 'settings');
  assert.equal(p.commandIn(['electron', '.', '--settings', '--wilfred-quitx']), null);
  assert.equal(p.commandIn([]), null);
  assert.equal(p.commandIn(), null);
});

test('the window shape covers the page\'s interactive parts, scaled and rounded outwards', () => {
  assert.deepEqual(p.shapeRects([{ x: 10, y: 20, w: 30, h: 40 }], 1), [{ x: 10, y: 20, width: 30, height: 40 }]);
  assert.deepEqual(p.shapeRects([{ x: 10.4, y: 20.6, w: 30.2, h: 0.5 }], 1.5), [{ x: 15, y: 30, width: 46, height: 2 }]);
  assert.deepEqual(p.shapeRects([{ x: 1, y: 1, w: 2, h: 2 }, { x: 5, y: 5, w: 1, h: 1 }], 2), [{ x: 2, y: 2, width: 4, height: 4 }, { x: 10, y: 10, width: 2, height: 2 }]);
  // Never left of or above the window.
  assert.deepEqual(p.shapeRects([{ x: -5, y: -5, w: 10, h: 10 }], 1), [{ x: 0, y: 0, width: 5, height: 5 }]);
});

test('a malformed shape report is ignored, and nothing usable leaves one corner pixel', () => {
  const pixel = [{ x: 0, y: 0, width: 1, height: 1 }];
  assert.equal(p.shapeRects('rects', 1), null);
  assert.equal(p.shapeRects([], 0), null);
  assert.equal(p.shapeRects([], -1), null);
  assert.equal(p.shapeRects([], NaN), null);
  assert.equal(p.shapeRects([], '1'), null);
  assert.equal(p.shapeRects(new Array(65).fill({ x: 0, y: 0, w: 1, h: 1 }), 1), null);
  assert.deepEqual(p.shapeRects([], 1), pixel);
  assert.deepEqual(p.shapeRects([null, { x: 0, y: 0, w: 0, h: 5 }, { x: 0, y: 0, w: 5, h: -1 }, { x: 'a', y: 0, w: 1, h: 1 },
    { x: 0, y: NaN, w: 1, h: 1 }, { x: 0, y: 0, w: Infinity, h: 1 }, { x: 0, y: 0, w: 1 }], 1), pixel);
  // Entirely left of or above the window: nothing left of it.
  assert.deepEqual(p.shapeRects([{ x: -10, y: 0, w: 5, h: 5 }, { x: 0, y: -10, w: 5, h: 5 }], 1), pixel);
});

test('while dragging, the shape is the whole window', () => {
  assert.deepEqual(p.fullShape(624, 300.4), [{ x: 0, y: 0, width: 624, height: 300 }]);
  assert.deepEqual(p.fullShape(0, 0), [{ x: 0, y: 0, width: 1, height: 1 }]);
});

// ---- crash recovery ----

test('a crashed board reloads at once, then at most every 2 s, and gives up after 5 in 30 s', () => {
  const first = p.reloadPlan([], 1000);
  assert.deepEqual(first, { delay: 0, times: [1000] });
  assert.deepEqual(p.reloadPlan(undefined, 1000), { delay: 0, times: [1000] });
  // A second crash 500 ms later waits for the gap.
  assert.deepEqual(p.reloadPlan(first.times, 1500), { delay: 1500, times: [1000, 3000] });
  let times = [];
  let now = 0;
  for (let i = 0; i < 5; i++) {
    const plan = p.reloadPlan(times, now);
    assert.ok(plan);
    times = plan.times;
    now += 3000;
  }
  assert.equal(p.reloadPlan(times, now), null);
  // Thirty seconds later the old crashes no longer count.
  assert.deepEqual(p.reloadPlan(times, 12000 + 30000), { delay: 0, times: [42000] });
});

// ---- Linux launcher entry ----

test('the launcher entry starts Wilfred from his folder, with show, settings and quit actions', () => {
  const text = p.desktopEntry('/home/me/wilfred');
  assert.match(text, /^\[Desktop Entry\]\nType=Application\nName=Wilfred\n/);
  assert.match(text, /^Exec="\/home\/me\/wilfred\/start-wilfred\.sh"$/m);
  assert.match(text, /^TryExec=\/home\/me\/wilfred\/start-wilfred\.sh$/m);
  assert.match(text, /^Path=\/home\/me\/wilfred$/m);
  assert.match(text, /^Icon=wilfred$/m);
  assert.match(text, /^StartupWMClass=wilfred$/m);
  assert.match(text, /^Actions=show;settings;quit;$/m);
  assert.match(text, /\[Desktop Action show\]\nName=Show or hide Wilfred\nExec="\/home\/me\/wilfred\/start-wilfred\.sh" --wilfred-toggle\n/);
  assert.match(text, /\[Desktop Action settings\]\nName=Settings\nExec="\/home\/me\/wilfred\/start-wilfred\.sh" --wilfred-settings\n/);
  assert.match(text, /\[Desktop Action quit\]\nName=Quit Wilfred\nExec="\/home\/me\/wilfred\/start-wilfred\.sh" --wilfred-quit\n/);
  // Every action's flag is one commandIn understands.
  for (const flag of text.match(/--wilfred-\w+/g)) assert.notEqual(p.commandIn([flag]), null);
  // A folder with a space and a quote stays one argument.
  assert.match(p.desktopEntry('/home/me/my "wilfred"'), /^Exec="\/home\/me\/my \\\\"wilfred\\\\"\/start-wilfred\.sh"$/m);
});

test('the launcher entry and its icon go under $XDG_DATA_HOME, else ~/.local/share', () => {
  const f = p.launcherFiles({ appPath: '/home/me/wilfred', home: '/home/me' });
  assert.equal(f.entryPath, path.join('/home/me', '.local', 'share', 'applications', 'wilfred.desktop'));
  assert.equal(f.iconPath, path.join('/home/me', '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'wilfred.png'));
  assert.equal(f.iconSource, path.join('/home/me/wilfred', 'assets', 'wilfred-256.png'));
  assert.equal(f.entryText, p.desktopEntry('/home/me/wilfred'));
  const x = p.launcherFiles({ appPath: '/a', home: '/home/me', env: { XDG_DATA_HOME: '/data' } });
  assert.equal(x.entryPath, path.join('/data', 'applications', 'wilfred.desktop'));
  assert.equal(p.launcherFiles({ appPath: '/a', home: '/home/me', env: { XDG_DATA_HOME: 'rel' } }).entryPath, f.entryPath);
  assert.equal(p.launcherFiles({ appPath: '/a', home: '/home/me', env: { XDG_DATA_HOME: '' } }).entryPath, f.entryPath);
  assert.equal(p.launcherFiles({ appPath: '/a', home: '/home/me', env: { XDG_DATA_HOME: 1 } }).entryPath, f.entryPath);
});

test('the launcher entry is added with its icon, seen, and removed again', () => {
  const home = tmp();
  const appPath = path.join(home, 'wilfred');
  fs.mkdirSync(path.join(appPath, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'assets', 'wilfred-256.png'), path.join(appPath, 'assets', 'wilfred-256.png'));
  const args = { appPath, home, env: {} };
  const f = p.launcherFiles(args);
  assert.equal(p.launcherInstalled(args), false);
  p.installLauncher(args);
  assert.equal(p.launcherInstalled(args), true);
  assert.equal(fs.readFileSync(f.entryPath, 'utf8'), f.entryText);
  assert.deepEqual(fs.readFileSync(f.iconPath), fs.readFileSync(path.join(ROOT, 'assets', 'wilfred-256.png')));
  p.installLauncher(args); // again: fine
  p.removeLauncher(args);
  assert.equal(p.launcherInstalled(args), false);
  assert.equal(fs.existsSync(f.iconPath), false);
  p.removeLauncher(args); // already gone: fine
  fs.rmSync(home, { recursive: true, force: true });
});

test('the launcher functions use the file system they are given', () => {
  const calls = [];
  const fake = {
    mkdirSync: (d) => calls.push(['mkdir', d]),
    copyFileSync: (a, b) => calls.push(['copy', a, b]),
    writeFileSync: (f) => calls.push(['write', f]),
    rmSync: (f) => calls.push(['rm', f]),
    existsSync: (f) => { calls.push(['exists', f]); return true; },
  };
  const args = { appPath: '/home/me/wilfred', home: '/home/me', fsImpl: fake };
  const f = p.launcherFiles(args);
  p.installLauncher(args);
  assert.equal(p.launcherInstalled(args), true);
  p.removeLauncher(args);
  assert.deepEqual(calls, [
    ['mkdir', path.dirname(f.iconPath)], ['copy', f.iconSource, f.iconPath], ['mkdir', path.dirname(f.entryPath)], ['write', f.entryPath],
    ['exists', f.entryPath], ['rm', f.entryPath], ['rm', f.iconPath],
  ]);
});

// ---- the launch scripts ----

test('the Linux and Mac launch scripts are LF-only and never turn the sandbox off', () => {
  for (const file of ['start-wilfred.sh', 'start-wilfred.command', path.join('tools', 'linux-apparmor.sh')]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(text.includes('\r'), false, `${file} has CR line endings`);
    assert.match(text, /^#!\/(usr\/bin\/env bash|bin\/sh)\n/, `${file} has no shebang`);
    assert.equal(text.includes('--no-sandbox'), false, `${file} turns the sandbox off`);
  }
});

// A fresh clone must be able to run the scripts: git keeps the executable bit, and only git can
// (Windows checkouts don't). Checked where there is a checkout to ask; skipped elsewhere (a ZIP).
test('the launch scripts are executable in git', (t) => {
  const scripts = ['start-wilfred.sh', 'tools/linux-apparmor.sh', 'start-wilfred.command'];
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-s', '--', ...scripts], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return t.skip('not a git checkout');
  }
  const lines = out.split('\n').filter(Boolean);
  if (!lines.length) return t.skip('the scripts are not tracked yet');
  for (const line of lines) {
    assert.match(line, /^100755 /, `${line.split('\t')[1]} is not executable in git: git update-index --chmod=+x <file>`);
  }
});

test('start-wilfred.sh runs through XWayland unless you opt out, refuses root, and checks the sandbox first', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'start-wilfred.sh'), 'utf8');
  assert.match(sh, /readlink -f "\$0"/);
  assert.match(sh, /--ozone-platform=x11/);
  assert.match(sh, /WILFRED_WAYLAND/);
  assert.match(sh, /id -u/);
  assert.match(sh, /setsid -f/);
  assert.match(sh, /--foreground/);
  assert.match(sh, /apparmor_restrict_unprivileged_userns/);
  assert.match(sh, /tools\/linux-apparmor\.sh/);
  const cmd = fs.readFileSync(path.join(ROOT, 'start-wilfred.command'), 'utf8');
  assert.match(cmd, /open -n -a "\$APP" --args "\$PWD" "\$@"/);
  assert.equal(cmd.includes('nohup'), false);
});

test('Windows: the Start Menu shortcut that names notifications', () => {
  assert.equal(p.APP_ID, 'com.arduuslabs.wilfred');
  const appData = path.join('C:', 'Users', 'me', 'AppData', 'Roaming');
  assert.equal(p.startMenuShortcutPath(appData), path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Wilfred.lnk'));
  const appPath = path.join('C:', 'wilfred');
  const execPath = path.join(appPath, 'node_modules', 'electron', 'dist', 'electron.exe');
  const s = p.startMenuShortcut({ execPath, appPath });
  assert.deepEqual(s, {
    target: execPath, args: `"${appPath}"`, cwd: appPath, description: 'Wilfred: what every Claude session is doing',
    icon: path.join(appPath, 'assets', 'wilfred.ico'), iconIndex: 0, appUserModelId: 'com.arduuslabs.wilfred',
  });
  // Read back: the same in any case is current; a moved folder, an old icon or another ID is not.
  assert.equal(p.shortcutCurrent(null, s), false);
  assert.equal(p.shortcutCurrent(s, s), true);
  assert.equal(p.shortcutCurrent({ ...s, target: s.target.toUpperCase(), description: '' }, s), true);
  assert.equal(p.shortcutCurrent({ ...s, args: `"${path.join('C:', 'elsewhere')}"` }, s), false);
  assert.equal(p.shortcutCurrent({ ...s, icon: path.join('C:', 'old', 'wilfred.ico') }, s), false);
  assert.equal(p.shortcutCurrent({ ...s, appUserModelId: undefined }, s), false);
  // Once Electron has registered an activator ID, Wilfred's entry carries it, and an entry without it is stale.
  const clsid = '{B45EE618-8848-4576-BD3B-AB09D226CFB4}';
  const withId = p.startMenuShortcut({ execPath, appPath, clsid });
  assert.equal(withId.toastActivatorClsid, clsid);
  assert.equal(p.shortcutCurrent(s, withId), false);
  assert.equal(p.shortcutCurrent({ ...s, toastActivatorClsid: clsid.toLowerCase() }, withId), true);
  assert.equal(p.shortcutCurrent({ ...s, toastActivatorClsid: clsid }, s), true, 'an ID not asked for is not compared');
  // Electron's own entry, as Electron would write it: the bare exe, its folder, the id, the activator ID.
  assert.equal(p.electronShortcutPath(appData), path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk'));
  assert.deepEqual(p.electronShortcut({ execPath, clsid }), { target: execPath, cwd: path.dirname(execPath), appUserModelId: 'com.arduuslabs.wilfred', toastActivatorClsid: clsid });
});
