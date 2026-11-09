// First of all: this process can't reach the network (see no-network.js and lockChromium below).
const { lockNetwork, verifyNetworkLocked, lockChromiumSwitches, lockSession, ALLOWED_EXTERNAL } = require('./no-network');

lockNetwork();

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, nativeTheme, Notification, globalShortcut, clipboard, powerMonitor, screen, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const loginMac = require('./login-mac');
const loginLinux = require('./login-linux');
const platform = require('./platform');
const { SessionSource } = require('./sessions/source');
const { demoRows } = require('./demo');
const { trayTooltip, statusText } = require('./renderer/view');
const { compareRows } = require('./sessions/status');
const {
  WIDTH, SIZES, HOUR_CHOICES, defaultState, parseState, validSetting, displayHomepage, writeState, defaultAnchor, anchorOnScreen,
  windowBounds, clampBounds, pagePoint, maxListHeight, pointInside, sessionUrl, loadAvatar, validHeight, windowHours,
  privacyLines, LOGIN_NAME, loginStatus,
} = require('./window-logic');
const { Quiet } = require('./quiet');
const { Notifier } = require('./notify');
const { Journal } = require('./journal');
const { SHORTCUT_CHOICES, shortcutLabel } = require('./shortcuts');
const { DEFAULT_THEME, BUILTIN_DIR, customDir, listThemes, resolveTheme, saveCurrentAsCustom, seedBuiltins, watchThemes } = require('./themes');

// The hours shown until you pick them in Settings (which saves them).
const WINDOW_HOURS = windowHours(process.env.WILFRED_WINDOW_HOURS);
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const demo = process.argv.includes('--demo');
// --settings opens the settings window at startup, --settings=<page> at that page (with
// --screenshot=, that window is captured).
const settingsFlag = process.argv.find((a) => a === '--settings' || a.startsWith('--settings='));
const settingsArg = !!settingsFlag;
const settingsPage = settingsFlag && /^--settings=[a-z-]+$/.test(settingsFlag) ? settingsFlag.slice('--settings='.length) : '';
// --theme=<id> shows that theme for this run without saving it (for design screenshots).
const themeArg = process.argv.find((a) => a.startsWith('--theme='));
// --wilfred-toggle / --wilfred-settings / --wilfred-quit: what the Linux launcher's actions ask for.
const launchCommand = platform.commandIn(process.argv);
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const asset = (name) => path.join(__dirname, '..', 'assets', name);

// Settings live in %APPDATA%\Wilfred; --user-data-dir=<folder> or --demo use their own, so a
// test run never touches your real settings. Must be set before the single-instance lock.
app.setName('Wilfred');
// Linux: the window class and launcher badges match the launcher entry (wilfred.desktop).
if (isLinux) app.setDesktopName('wilfred.desktop');
// Windows groups his windows and names his notifications by this id (see registerForNotifications).
if (isWindows) app.setAppUserModelId(platform.APP_ID);
// A native Wayland window can't place itself or stay on top, and the switch that avoids it only
// works on the real command line: start again through XWayland, before anything else happens.
const relaunching = platform.relaunchForX11({ platform: process.platform, env: process.env, ozoneSwitch: app.commandLine.getSwitchValue('ozone-platform') });
if (relaunching) {
  app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
  app.exit(0);
}
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.slice('--user-data-dir='.length)));
else if (demo) app.setPath('userData', path.join(app.getPath('appData'), 'Wilfred-demo'));

lockChromiumSwitches(app);

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// A second launch only pokes the running pet; it must not run any of the setup below. A first
// launch asked to quit (the launcher's "Quit Wilfred" while he isn't running) has nothing to do.
if (!relaunching) {
  if (!app.requestSingleInstanceLock() || launchCommand === 'quit') app.exit(0);
  else start();
}

function start() {
  const statePath = () => path.join(app.getPath('userData'), 'state.json');
  let state = defaultState();
  let cssHeight = 100;
  let win = null;
  let settingsWin = null;
  let tray = null;
  let source = null;
  let ignoring = true;
  // The startup network check, shown in the menu (see privacyItem).
  let networkCheck = { blocked: [], open: [] };
  const trayWays = platform.trayBehaviour(process.platform);
  // Snoozes and do not disturb; notifications (once the settings are read); the day book.
  const quiet = new Quiet();
  let notifier = null;
  let journal = null;
  const journalDir = () => path.join(app.getPath('userData'), 'journal');
  // The rows as the source (or the demo) gives them, and as shown: quieted, the watched one marked.
  let rawRows = [];
  let latestRows = [];

  const log = (...args) => console.log(new Date().toISOString(), ...args);

  function loadState() {
    let text = '';
    try {
      text = fs.readFileSync(statePath(), 'utf8');
    } catch {
      // First run: the defaults.
    }
    state = parseState(text, { windowHours: WINDOW_HOURS });
  }

  function saveState() {
    try {
      writeState(statePath(), state);
    } catch (e) {
      log('could not save state', e.message);
    }
  }

  const primaryAnchor = () => defaultAnchor(screen.getPrimaryDisplay().workArea);

  // Keeps the pet on a connected screen, so one left on an unplugged monitor comes back.
  function ensureVisible() {
    if (anchorOnScreen(state.anchor, screen.getAllDisplays().map((d) => d.workArea))) return false;
    state.anchor = primaryAnchor();
    return true;
  }

  // Where the window goes: grown up and left from the anchor, then kept inside its screen.
  function bounds() {
    const b = windowBounds(state.anchor, cssHeight, state.zoom);
    const { workArea } = screen.getDisplayMatching(b);
    return { b: clampBounds(b, workArea), workArea };
  }

  // Moving onto a screen with another scaling can leave Windows' idea of the size wrong; the same
  // bounds a second time put it right. On a Mac, a transparent window's shadow is recomputed.
  let boardDisplay = null;
  let boardBounds = null;
  function setBoardBounds(b) {
    win.setBounds(b);
    const id = screen.getDisplayMatching(b).id;
    if (boardDisplay !== null && id !== boardDisplay) win.setBounds(b);
    boardDisplay = id;
    boardBounds = b;
    if (isMac) {
      try {
        win.invalidateShadow();
      } catch {
        // cosmetic only
      }
    }
  }

  function place() {
    const { b, workArea } = bounds();
    setBoardBounds(b);
    // The page moved under a still pointer: tell it where the pointer now is, so it can decide
    // whether to catch clicks (its own last coordinates belong to the old position).
    if (!drag) {
      const point = pagePoint(screen.getCursorScreenPoint(), b, state.zoom);
      if (point) win.webContents.send('hover-check', point);
      else if (!ignoring) {
        setIgnore(true);
        win.webContents.send('hover-reset');
      }
    }
    const listMax = maxListHeight(workArea, state.zoom);
    if (listMax !== sentListMax) {
      sentListMax = listMax;
      win.webContents.send('list-max', listMax);
    }
  }
  let sentListMax = null;

  // Linux can't forward the pointer to an ignoring window, so there the window's shape decides
  // where clicks land (see applyShape) and this is never used.
  function setIgnore(v) {
    if (isLinux || v === ignoring || !win) return;
    ignoring = v;
    win.setIgnoreMouseEvents(v, { forward: true });
  }

  // Linux click-through: only the page's interactive parts (as it last reported them, in CSS
  // pixels) catch clicks; while dragging, the whole window does, so the pointer can't slip off.
  let shapeCss = null;
  let shapeFailed = false;
  function applyShape() {
    if (!isLinux || !win || !boardBounds) return;
    const rects = drag ? platform.fullShape(boardBounds.width, boardBounds.height) : shapeCss && platform.shapeRects(shapeCss, state.zoom);
    if (!rects) return;
    try {
      win.setShape(rects);
    } catch (e) {
      if (!shapeFailed) log('could not set the window shape', e.message);
      shapeFailed = true;
    }
  }

  // Kept out of screen shares and recordings, where the system can do it (not on Linux).
  function protect(w, v) {
    if (platform.contentProtectionSupported(process.platform)) w.setContentProtection(v);
  }

  // On a Mac, on every Space and over full-screen apps; the process is already a UI element
  // (the Dock was hidden first), so no second transform that would blink the window.
  function joinAllSpaces() {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // After sleep, a lock, a screen change or an Explorer restart, the system may have dropped the
  // board's place on top, out of the taskbar or on every Space: set them all again.
  function reassertOverlay() {
    if (!win || win.isDestroyed()) return;
    const plan = platform.reassertPlan(process.platform);
    win.setAlwaysOnTop(true, 'floating');
    if (plan.skipTaskbar) win.setSkipTaskbar(true);
    if (plan.allSpaces) joinAllSpaces();
    if (tray) tray.setToolTip(trayTip());
    ensureVisible();
    place();
  }

  // A crashed page leaves an invisible, unclickable window: reload it, but never in a tight loop.
  let reloads = [];
  let reloadTimer = null;
  function recoverBoard(why) {
    if (!win || win.isDestroyed() || reloadTimer) return;
    const plan = platform.reloadPlan(reloads, Date.now());
    if (!plan) return log(`board ${why}: it crashed too often, not reloading again`);
    reloads = plan.times;
    log(`board ${why}: reloading${plan.delay ? ` in ${plan.delay} ms` : ''}`);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (win && !win.isDestroyed()) win.webContents.reload();
    }, plan.delay);
  }

  function openSession(id) {
    const url = sessionUrl(id);
    if (!ALLOWED_EXTERNAL.test(url)) return; // never anything but the Claude app
    shell.openExternal(url).catch((e) => log('could not open', url, e.message));
  }

  function setZoom(zoom) {
    state.zoom = zoom;
    saveState();
    win.webContents.setZoomFactor(zoom);
    if (ensureVisible()) saveState();
    place();
    applyShape();
  }

  function setCollapsed(v) {
    state.collapsed = v;
    saveState();
    if (win) win.webContents.send('collapsed', v);
    refreshTrayMenu();
  }

  // The theme on screen; the menu marks it and "save as custom" copies it.
  let currentTheme = null;
  let themeOverride = themeArg ? themeArg.slice('--theme='.length) : '';
  const themeOpts = () => ({ builtinDir: BUILTIN_DIR, userDataDir: app.getPath('userData') });

  // The board and the settings window wear the same theme.
  function sendTheme() {
    const { id, name, css } = currentTheme;
    for (const w of [win, settingsWin]) if (w) w.webContents.send('theme', { id, name, css });
  }

  function applyTheme() {
    currentTheme = resolveTheme(themeOverride || state.theme || DEFAULT_THEME, themeOpts());
    sendTheme();
    pushSnapshot();
    watchThemesFolder();
  }

  // Copies of the built-ins, a README and the theme docs in the themes folder, so there is something
  // to start from. Returns false when the folder couldn't be made.
  function seedThemesFolder() {
    const { errors } = seedBuiltins({ ...themeOpts(), docsFile: path.join(app.getAppPath(), 'docs', 'themes.md') });
    for (const e of errors) log('themes folder:', e);
    return fs.existsSync(customDir(app.getPath('userData')));
  }

  function selectTheme(id) {
    themeOverride = '';
    state.theme = id;
    saveState();
    applyTheme();
  }

  // Edits to the theme on screen (your own, or your copy of a built-in) apply as soon as the file is
  // saved. The folder may not exist yet: watching is tried again whenever a theme is applied or the
  // folder is made.
  let stopWatching = null;
  function watchThemesFolder() {
    if (stopWatching) return;
    stopWatching = watchThemes(app.getPath('userData'), reloadTheme, {
      onError: (e) => {
        stopWatching = null;
        log('themes folder watch stopped:', e.message);
      },
    });
  }
  // Resolved afresh, so a deleted copy brings the built-in back and a deleted custom theme the default.
  // The settings' theme list follows any change in the folder (a new file, an edit, a deletion).
  function reloadTheme() {
    pushSnapshot();
    const fresh = resolveTheme(currentTheme.id, themeOpts());
    if (fresh.css === currentTheme.css) return;
    currentTheme = fresh;
    sendTheme();
  }

  function openThemesFolder() {
    const dir = customDir(app.getPath('userData'));
    if (!seedThemesFolder()) return log('could not create themes folder', dir);
    watchThemesFolder();
    shell.openPath(dir).then((err) => { if (err) log('could not open themes folder', err); });
  }

  function saveThemeAsCustom() {
    try {
      selectTheme(saveCurrentAsCustom(currentTheme, { userDataDir: app.getPath('userData') }));
    } catch (e) {
      return log('could not save theme', e.message);
    }
    openThemesFolder();
  }

  // Never show() or focus() the board: it must not take the focus from what you are doing.
  function setShown(v) {
    if (v) win.showInactive();
    else win.hide();
    refreshTrayMenu();
  }

  // Start at login. Windows: a startup entry named Wilfred that runs this exe on this app folder.
  // Mac: a LaunchAgent doing the same (see login-mac.js). Linux: an autostart entry that runs
  // start-wilfred.sh (see login-linux.js). A downloaded Wilfred (packaged) is his own exe and finds
  // his folder himself, so there it runs alone.
  const home = os.homedir();
  const loginArgs = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
  const macLogin = { home, execPath: process.execPath, appPath: app.getAppPath(), env: process.env, packaged: app.isPackaged };
  const linuxLogin = { home, env: process.env, launcher: path.join(app.getAppPath(), 'start-wilfred.sh') };
  function startsAtLogin() {
    if (isMac) return loginMac.isOn(home);
    if (isLinux) return loginLinux.isOn(home, process.env);
    return loginStatus(app.getLoginItemSettings(loginArgs).launchItems).on;
  }
  function setStartAtLogin(on) {
    if (isMac) loginMac.setOn(on, macLogin);
    else if (isLinux) loginLinux.setOn(on, linuxLogin);
    else app.setLoginItemSettings({ ...loginArgs, name: LOGIN_NAME, openAtLogin: on });
  }
  // Earlier versions registered under Electron's default name ("Electron" in Task Manager).
  // Replace it with one named Wilfred, keeping whether you had it switched on, and only once the
  // old one is really gone (one Wilfred can't remove, such as a machine-wide entry, is left alone).
  function renameOldLoginEntry() {
    const { stale } = loginStatus(app.getLoginItemSettings(loginArgs).launchItems);
    if (!stale.length) return;
    for (const { name } of stale) app.setLoginItemSettings({ ...loginArgs, name, openAtLogin: false });
    if (loginStatus(app.getLoginItemSettings(loginArgs).launchItems).stale.length) return;
    if (stale.some((s) => s.enabled)) setStartAtLogin(true);
    log(`start-with-Windows entry renamed to ${LOGIN_NAME} (was ${stale.map((s) => s.name).join(', ')})`);
  }
  // A moved folder or a reinstalled Electron leaves the Mac's LaunchAgent pointing nowhere.
  function refreshMacLogin() {
    try {
      if (loginMac.refresh(macLogin)) log('start-at-login entry updated for this folder');
    } catch (e) {
      log('could not update the start-at-login entry', e.message);
    }
  }

  // Linux: Wilfred in the app menu and the dock (a Settings action; see platform.js launcherFiles).
  const launcherArgs = { appPath: app.getAppPath(), home, env: process.env };
  function launcherState() {
    if (!isLinux) return null;
    try {
      return { installed: platform.launcherInstalled(launcherArgs) };
    } catch {
      return { installed: false };
    }
  }
  function installLauncher() {
    if (!isLinux) return;
    platform.installLauncher(launcherArgs);
    log('added to the app menu');
    pushSnapshot();
  }
  function removeLauncher() {
    if (!isLinux) return;
    platform.removeLauncher(launcherArgs);
    log('removed from the app menu');
    pushSnapshot();
  }

  // The startup check as a line anyone can read, with a green mark when nothing can get out (a red
  // one if that ever changed), and the proof one level down.
  function privacyItem() {
    const p = privacyLines(networkCheck);
    return {
      label: p.label,
      icon: nativeImage.createFromPath(asset(p.ok ? 'menu-check.png' : 'menu-cross.png')),
      submenu: [
        { label: p.detail, enabled: false },
        { label: "Reads the Claude app's session files; writes only inside its own settings folder", enabled: false },
        { type: 'separator' },
        // An item with a submenu gets no click of its own, so the page is an entry in it.
        { label: 'Privacy settings…', click: () => openSettings('privacy') },
        { label: "How it's enforced…", click: openSecurity },
      ],
    };
  }

  function openSecurity() {
    shell.openPath(path.join(app.getAppPath(), 'SECURITY.md')).then((err) => { if (err) log('could not open SECURITY.md', err); });
  }

  // The same menu on Wilfred and on the tray icon; the tray also offers to show or hide him.
  // Everything else lives in Settings.
  function menuTemplate({ fromTray }) {
    return [
      ...(fromTray ? [{ label: win.isVisible() ? 'Hide Wilfred' : 'Show Wilfred', click: () => setShown(!win.isVisible()) }] : []),
      { label: state.collapsed ? 'Show sessions' : 'Hide sessions', click: () => { setShown(true); setCollapsed(!state.collapsed); } },
      { label: 'Open Claude', click: () => openSession('') },
      { label: 'Copy status as text', click: () => clipboard.writeText(statusText(latestRows, Date.now())) },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettings() },
      { label: 'Day book…', click: () => openSettings('today') },
      dndItem(),
      privacyItem(),
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ];
  }

  // Do not disturb, with how long it lasts in its own label while it is on.
  function dndItem() {
    return {
      label: quiet.dnd() ? quiet.dndLabel() : 'Do not disturb',
      submenu: [
        { label: 'For 30 minutes', click: () => setDnd(30) },
        { label: 'For an hour', click: () => setDnd(60) },
        { label: 'For two hours', click: () => setDnd(120) },
        { label: 'Until I turn it off', click: () => setDnd(null) },
        { type: 'separator' },
        { label: 'Off', enabled: quiet.dnd(), click: () => setDnd(0) },
      ],
    };
  }

  // Menus that are built once and handed over must be built again when what they say changes:
  // the Linux tray's (it has no pop-up menu) and the Dock's.
  function refreshTrayMenu() {
    if (!win) return;
    const menu = () => Menu.buildFromTemplate(menuTemplate({ fromTray: true }));
    if (tray && trayWays.attachMenu) tray.setContextMenu(menu());
    if (dockMode()) app.dock.setMenu(menu());
  }

  // ---- the Dock (macOS) ----

  // Wilfred lives in the menu bar; Dock mode (a setting) also gives him a Dock icon with a badge.
  const dockMode = () => isMac && !!app.dock && state.dock === true;
  // macOS drops a hide or show within a second of the last one, so changes wait their turn.
  let dockChangedAt = 0;
  let dockTimer = null;
  function applyDock() {
    if (!isMac || !app.dock) return;
    clearTimeout(dockTimer);
    const wait = platform.dockWait(dockChangedAt, Date.now());
    if (wait) {
      dockTimer = setTimeout(applyDock, wait);
      return;
    }
    const want = dockMode();
    if (want === app.dock.isVisible()) return;
    dockChangedAt = Date.now();
    if (want) {
      app.dock.show().then(() => {
        refreshTrayMenu();
        updateBadges(true);
      }).catch((e) => log('could not show the Dock icon', e.message));
    } else {
      app.dock.setBadge('');
      app.dock.hide();
    }
  }

  // The sessions waiting on you, counted where the platform shows it: the menu bar title, the
  // Dock badge (which bounces once when the count goes up), the Linux launcher badge.
  let attention = 0;
  function updateBadges(force = false) {
    const n = platform.attentionCount(latestRows);
    if (n === attention && !force) return;
    const rose = n > attention;
    attention = n;
    const places = platform.badgePlaces(process.platform, dockMode());
    const text = platform.dockBadge(latestRows);
    if (places.trayTitle && tray) tray.setTitle(text, { fontType: 'monospacedDigit' });
    if (places.dock) {
      app.dock.setBadge(text);
      if (rose) app.dock.bounce('informational');
    }
    if (places.count) {
      try {
        app.setBadgeCount(n);
      } catch (e) {
        log('could not set the badge', e.message);
      }
    }
  }

  function resetPosition() {
    state.anchor = primaryAnchor();
    saveState();
    place();
    setShown(true);
  }

  // Kept out of screen shares and recordings: the board, and the settings window with it.
  function setHidden(v) {
    state.hidden = v;
    for (const w of [win, settingsWin]) if (w) protect(w, v);
    saveState();
  }

  function setWindowHours(hours) {
    state.windowHours = hours;
    saveState();
    // The source reads windowMs on every scan; scan now so the board follows at once.
    if (source) {
      source.windowMs = hours * 3600e3;
      source.tick();
    }
  }

  function setAppearance(v) {
    state.appearance = v;
    saveState();
    nativeTheme.themeSource = v;
  }

  // ---- the settings window ----

  // package.json, read once: the version and the project page for About.
  let pkg = null;
  function packageInfo() {
    if (pkg) return pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    } catch (e) {
      log('could not read package.json', e.message);
      return {};
    }
    return pkg;
  }

  const loginSupported = isMac || isWindows || isLinux;
  function loginOn() {
    try {
      return startsAtLogin();
    } catch (e) {
      log('could not read the start-at-login setting', e.message);
      return false;
    }
  }

  function snapshot() {
    const { version = '', homepage } = packageInfo();
    return {
      version,
      homepage: displayHomepage(homepage),
      platform: process.platform,
      zoom: state.zoom,
      sizes: SIZES,
      windowHours: state.windowHours,
      hourChoices: HOUR_CHOICES,
      startAtLogin: loginSupported ? loginOn() : null,
      hidden: state.hidden,
      appearance: state.appearance,
      theme: currentTheme.id,
      themes: listThemes(themeOpts()).map(({ id, name, custom, edited, description }) => ({ id, name, custom, edited, description })),
      privacy: privacyLines(networkCheck),
      launcher: launcherState(),
      notify: state.notify,
      registered: registeredWithWindows(),
      shortcuts: state.shortcuts,
      shortcutChoices: SHORTCUT_CHOICES.map(([, accel]) => [shortcutLabel(accel, process.platform), accel]),
      shortcutProblems,
      dnd: { on: quiet.dnd(), until: quiet.dnd() ? (quiet.dndUntil === Infinity ? null : quiet.dndUntil) : 0, label: quiet.dndLabel() },
      watch: state.watch,
      families: state.families,
      dock: isMac ? state.dock : null,
      journal: journal ? journal.today() : null,
    };
  }

  function pushSnapshot() {
    if (!settingsWin) return;
    try {
      settingsWin.webContents.send('settings:snapshot', snapshot());
    } catch (e) {
      log('could not update the settings window', e.message);
    }
  }

  // Each change is checked for shape first; anything malformed changes nothing.
  function applySetting(key, value) {
    if (!validSetting(key, value)) return;
    if (key === 'zoom') setZoom(value);
    else if (key === 'windowHours') setWindowHours(value);
    else if (key === 'startAtLogin') { if (loginSupported) setStartAtLogin(value); }
    else if (key === 'hidden') setHidden(value);
    else if (key === 'appearance') setAppearance(value);
    else if (key === 'theme' && listThemes(themeOpts()).some((t) => t.id === value)) selectTheme(value);
    else if (key === 'notify') setNotify(value);
    else if (key === 'shortcuts') setShortcuts(value);
    else if (key === 'families') { state.families = value; saveState(); sendMode(); }
    else if (key === 'dock') { state.dock = value; saveState(); applyDock(); }
    else if (key === 'watch') setWatch(value);
    else if (key === 'dnd') setDnd(value); // for now only: not saved
  }

  // The one address outside claude:// Wilfred opens, in your browser, on your click.
  function openHomepage() {
    const { homepage } = packageInfo();
    if (typeof homepage !== 'string' || !ALLOWED_EXTERNAL.test(homepage)) return log('project page not opened: not the expected address');
    shell.openExternal(homepage).catch((e) => log('could not open the project page', e.message));
  }

  const ACTIONS = {
    'reset-position': resetPosition,
    'open-themes-folder': openThemesFolder,
    'save-theme-copy': saveThemeAsCustom,
    'open-security': openSecurity,
    'open-homepage': openHomepage,
    'install-launcher': installLauncher,
    'remove-launcher': removeLauncher,
    'try-notification': tryNotification,
    'copy-journal': () => { if (journal) clipboard.writeText(journal.text()); },
    'copy-status': () => clipboard.writeText(statusText(latestRows, Date.now())),
    'open-journal-folder': openJournalFolder,
    close: () => { if (settingsWin) settingsWin.close(); },
  };

  // Only the settings window may read or change settings.
  const fromSettings = (e) => !!settingsWin && e.sender === settingsWin.webContents;
  let loggedGet = false;
  ipcMain.handle('settings:get', (e) => {
    if (!fromSettings(e)) return null;
    const snap = snapshot();
    if (!loggedGet) {
      loggedGet = true;
      log(`settings: snapshot sent (${snap.themes.length} themes, version ${snap.version})`);
    }
    return snap;
  });
  ipcMain.handle('settings:set', (e, msg) => {
    if (!fromSettings(e)) return null;
    const { key, value } = msg && typeof msg === 'object' ? msg : {};
    try {
      applySetting(key, value);
    } catch (err) {
      log('could not change setting', String(key), err.message);
    }
    return snapshot();
  });
  ipcMain.handle('settings:act', (e, name) => {
    if (!fromSettings(e)) return;
    const act = typeof name === 'string' && Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    if (!act) return;
    try {
      act();
    } catch (err) {
      log('settings action failed', name, err.message);
    }
  });

  // A normal window (in the taskbar, not on top), kept out of screen shares like the board.
  function openSettings(page = '') {
    if (settingsWin) {
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.focus();
      // Asked for a page (the Day book… item): the page reads it as it loads, so load it there.
      if (page) settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), { hash: page }).catch((e) => log('could not load the settings page', e.message));
      else pushSnapshot();
      return;
    }
    settingsWin = new BrowserWindow({
      width: 720,
      height: 560,
      minWidth: 640,
      minHeight: 460,
      frame: false,
      show: false,
      title: 'Wilfred settings',
      backgroundColor: '#1f1e1b',
      icon: asset('wilfred-256.png'),
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    protect(settingsWin, state.hidden);
    settingsWin.once('ready-to-show', () => settingsWin.show());
    settingsWin.webContents.on('did-finish-load', () => {
      log('settings window opened');
      sendTheme();
      pushSnapshot();
    });
    settingsWin.on('closed', () => { settingsWin = null; });
    settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), { hash: page }).catch((e) => log('could not load the settings page', e.message));
  }

  function showMenu() {
    Menu.buildFromTemplate(menuTemplate({ fromTray: false })).popup({ window: win });
  }

  // The tray: click shows or hides him. The menu is a right-click (or Ctrl-click on a Mac) away,
  // except on Linux, which has neither: there the menu is attached and opens on its own.
  function createTray() {
    const image = nativeImage.createFromPath(asset(platform.trayImageFor(process.platform)));
    tray = trayWays.guid ? new Tray(image, trayWays.guid) : new Tray(image);
    tray.setToolTip(trayTip());
    if (trayWays.ignoreDoubleClick) tray.setIgnoreDoubleClickEvents(true);
    const popMenu = () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate({ fromTray: true })));
    tray.on('click', (e) => (trayWays.ctrlClickMenu && e && e.ctrlKey ? popMenu() : setShown(!win.isVisible())));
    if (trayWays.rightClick) tray.on('right-click', popMenu);
    refreshTrayMenu();
    updateBadges(true);
  }

  function createWindow() {
    ensureVisible();
    win = new BrowserWindow(platform.boardWindowOptions(process.platform, {
      width: Math.round(WIDTH * state.zoom),
      height: 100,
      iconPath: asset('wilfred-256.png'),
      preload: path.join(__dirname, 'preload.js'),
    }));
    win.setAlwaysOnTop(true, 'floating');
    if (isMac) joinAllSpaces();
    protect(win, state.hidden);
    if (!isLinux) win.setIgnoreMouseEvents(true, { forward: true });
    place();
    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(state.zoom));
    win.webContents.on('render-process-gone', (_e, d) => {
      if (d && d.reason !== 'clean-exit') recoverBoard(`page gone (${d.reason})`);
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // Show the window once the page has reported its real height, so the board isn't clipped
    // for a moment; a fallback in case that report never comes.
    win.once('ready-to-show', () => setTimeout(() => { if (!shownOnce) showFirst(); }, 1500));
    // Nothing in the page should ever navigate or open windows.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  let shownOnce = false;
  function showFirst() {
    shownOnce = true;
    win.showInactive();
  }

  // ---- rows: quieted, journaled, notified ----

  const trayTip = (now = Date.now()) => (quiet.dnd(now) ? 'Do not disturb · ' : '') + trayTooltip(latestRows);

  // Every change of the board goes through here, from the source, the demo, a menu or the clock.
  function pushRows() {
    const now = Date.now();
    if (journal) {
      journal.observe(rawRows, now);
      flushJournal(now);
    }
    latestRows = quiet.apply(rawRows, now).map((r) => (r.id === state.watch ? { ...r, watched: true } : r));
    if (win) win.webContents.send('rows', latestRows);
    if (tray) tray.setToolTip(trayTip(now));
    updateBadges();
    notify(now);
    pushSnapshot(); // the settings window shows the day book live
  }

  // Written at most once a minute (the journal holds itself to that); a failure is logged once.
  let journalError = null;
  function flushJournal(now, opts) {
    if (journal.flush(now, opts) || !journal.lastError || journal.lastError === journalError) return;
    journalError = journal.lastError;
    log('could not write the day book', journalError.message);
  }

  function openJournalFolder() {
    const dir = journalDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return log('could not create the day book folder', e.message);
    }
    shell.openPath(dir).then((err) => { if (err) log('could not open the day book folder', err); });
  }

  // The operating system's own notifications; none while do not disturb is on (the notifier still
  // looks, so what changed meanwhile isn't told late). Called on every change and every few
  // seconds besides, since a question is told only once it has waited its grace.
  function notify(now) {
    if (!notifier) return;
    const notices = notifier.observe(latestRows, now, { watch: state.watch });
    if (quiet.dnd(now) || !notices.length) return;
    // Electron registers its activator on a background thread from the first touch of
    // Notification (isSupported included), so the entry it should find must be there before.
    lendElectronShortcut();
    if (!Notification.isSupported()) return;
    for (const n of notices) showNotice(n);
  }

  function showNotice(n) {
    try {
      const note = new Notification({ title: n.title, body: n.body, silent: !state.notify.sound });
      note.on('click', () => { if (n.id) openSession(n.id); else setShown(true); });
      note.on('failed', (_e, err) => log('notification failed', err));
      note.show();
      setTimeout(foldElectronShortcut, 3000);
      setTimeout(foldElectronShortcut, 7000);
    } catch (e) {
      log('notification failed', e.message);
    }
  }

  // Settings > Notifications > "Send one now": what one from Wilfred looks like, and what it's called.
  function tryNotification() {
    if (!state.notify.on) return;
    lendElectronShortcut(); // before the first touch of Notification, see notify()
    if (!Notification.isSupported()) return log('notifications are not supported here');
    showNotice({ id: '', title: 'Wilfred', body: "This is how I'll let you know." });
  }

  function setNotify(value) {
    const wasOn = state.notify.on;
    state.notify = { ...value };
    saveState();
    if (notifier) notifier.setOptions(state.notify);
    if (state.notify.on !== wasOn) registerForNotifications(state.notify.on);
  }

  // Windows names a notification after the Start Menu shortcut that carries the app's id. Run from a
  // checkout, Wilfred has none of his own, and Electron writes one for the id from a process's first
  // touch of Notification, named after electron.exe: "Electron" (with an activator id it mints
  // unless the file already holds one). So while notifications are on, Wilfred keeps an entry with
  // his name and icon (and so appears in the Start Menu and in Windows' notification settings),
  // lends Electron its own entry for the moment it registers, so the activator id stays the same
  // from run to run, and folds that entry into his. Switching off removes both. A downloaded Wilfred
  // (packaged) does none of this: his exe carries the name Wilfred, so the entry Electron writes
  // for him is already named Wilfred, and it points at that exe.
  const shortcutPath = () => platform.startMenuShortcutPath(app.getPath('appData'));
  const electronShortcutPath = () => platform.electronShortcutPath(app.getPath('appData'));
  // A demo, or a run with its own settings folder, is not the install: it leaves the entries alone.
  const handlesShortcuts = isWindows && !app.isPackaged && !demo && !userDataArg;
  function readShortcut(file) {
    try {
      return fs.existsSync(file) ? shell.readShortcutLink(file) : null;
    } catch {
      return null;
    }
  }
  const ownShortcut = (read) => !!read && read.appUserModelId === platform.APP_ID;
  const removeShortcut = (file, what) => {
    if (!ownShortcut(readShortcut(file))) return;
    fs.unlinkSync(file);
    log(`${what} removed`);
  };
  // The activator id Electron registered, remembered in the settings so it stays one id (and one
  // registry record) across runs and across switching off and on; before the first one, read from
  // Wilfred's entry or Electron's. Kept in memory too, so lending it is one quick write.
  let activator = '';
  function rememberActivator(clsid) {
    if (!clsid || clsid === activator) return;
    activator = clsid;
    if (state.toastActivator === clsid) return;
    state.toastActivator = clsid;
    saveState();
  }
  function activatorId() {
    if (activator) return activator;
    if (state.toastActivator) return (activator = state.toastActivator);
    for (const file of [shortcutPath(), electronShortcutPath()]) {
      const read = readShortcut(file);
      if (ownShortcut(read) && read.toastActivatorClsid) {
        rememberActivator(read.toastActivatorClsid);
        return activator;
      }
    }
    return '';
  }
  function registeredWithWindows() {
    if (!isWindows) return null;
    return app.isPackaged || ownShortcut(readShortcut(shortcutPath()));
  }
  let saidForeign = false;
  function writeOwnShortcut(clsid) {
    const file = shortcutPath();
    const read = readShortcut(file);
    // An entry named Wilfred that isn't his (no id, or another app's) is left alone.
    if (read && !ownShortcut(read)) {
      if (!saidForeign) log('a Start Menu entry named Wilfred belongs to something else: left alone');
      saidForeign = true;
      return;
    }
    const wanted = platform.startMenuShortcut({ execPath: process.execPath, appPath: app.getAppPath(), clsid });
    if (platform.shortcutCurrent(read, wanted)) return;
    if (!shell.writeShortcutLink(file, 'create', wanted)) throw new Error('the shortcut could not be written');
    log("Start Menu entry written: notifications carry Wilfred's name");
  }
  function registerForNotifications(on) {
    if (!handlesShortcuts) return;
    try {
      if (on) return writeOwnShortcut(activatorId());
      removeShortcut(shortcutPath(), 'Start Menu entry');
      // Electron may still be reading the entry it was just lent (it registers on a background
      // thread after a run's first notification). Taking it away now would make Electron mint a
      // second activator id and leave the first one's registry record behind, so it stays until
      // Electron is done, and the fold removes it.
      if (Date.now() - lentAt < LEND_SETTLES_MS) return void setTimeout(foldElectronShortcut, LEND_SETTLES_MS);
      removeShortcut(electronShortcutPath(), "Electron's own Start Menu entry");
    } catch (e) {
      log('could not update the Start Menu entry', e.message);
    }
  }
  let lent = false; // Electron registers once per run
  let lentAt = 0;
  const LEND_SETTLES_MS = 8000; // longer than the folds that follow a notification (3 s and 7 s)
  function lendElectronShortcut() {
    if (!handlesShortcuts || lent) return;
    lent = true;
    lentAt = Date.now();
    const clsid = activatorId();
    if (!clsid) return log('no toast activator id known yet: Electron mints one'); // folded into Wilfred's entry below
    try {
      if (!shell.writeShortcutLink(electronShortcutPath(), 'create', platform.electronShortcut({ execPath: process.execPath, clsid }))) throw new Error('not written');
      log('Start Menu entry lent to Electron with the known activator id');
    } catch (e) {
      log("could not lend Electron its Start Menu entry", e.message);
    }
  }
  function foldElectronShortcut() {
    if (!handlesShortcuts) return;
    try {
      const theirs = readShortcut(electronShortcutPath());
      if (!ownShortcut(theirs)) return;
      // The id already remembered stays (an entry left by a demo run carries another one);
      // Electron's is adopted only when there is none yet.
      activatorId();
      if (state.notify.on) {
        writeOwnShortcut(activator);
        // Wilfred's entry not in place (an entry named Wilfred that isn't his): Electron's stays, so
        // the id keeps a name, "Electron", as Settings says.
        if (!ownShortcut(readShortcut(shortcutPath()))) return;
      }
      removeShortcut(electronShortcutPath(), "Electron's own Start Menu entry");
    } catch (e) {
      log("could not fold Electron's Start Menu entry", e.message);
    }
  }

  // What the page shows beyond the rows: do not disturb, the watched session, nested families.
  let sentDnd = null;
  function sendMode() {
    sentDnd = quiet.dnd();
    if (win) win.webContents.send('mode', { dnd: sentDnd, watch: state.watch, families: state.families });
  }

  function setDnd(v) {
    quiet.setDnd(v);
    pushRows();
    sendMode();
    refreshTrayMenu();
  }

  function snooze(id, minutes) {
    quiet.snooze(id, minutes);
    pushRows();
  }

  let watchMissingSince = 0;
  function setWatch(id) {
    state.watch = id;
    watchMissingSince = 0;
    saveState();
    pushRows();
    sendMode();
  }

  // A watched session gone from the board for over an hour is no longer watched.
  const WATCH_GONE_MS = 60 * 60 * 1000;
  function checkWatch(now) {
    if (!state.watch || rawRows.some((r) => r.id === state.watch)) {
      watchMissingSince = 0;
      return;
    }
    if (!watchMissingSince) watchMissingSince = now;
    else if (now - watchMissingSince > WATCH_GONE_MS) setWatch('');
  }

  // Once a minute: snoozes and do not disturb run out on the clock, not on a session change.
  function minuteTick() {
    const now = Date.now();
    checkWatch(now);
    pushRows();
    if (quiet.dnd(now) !== sentDnd) {
      sendMode();
      refreshTrayMenu();
    }
  }

  // ---- global shortcuts ----

  let shortcutProblems = [];
  function applyShortcuts() {
    globalShortcut.unregisterAll();
    shortcutProblems = [];
    for (const [key, accel] of Object.entries(state.shortcuts)) {
      if (!accel) continue;
      let ok = false;
      try {
        ok = globalShortcut.register(accel, key === 'toggle' ? () => { if (win) setShown(!win.isVisible()); } : openMostUrgent);
      } catch (e) {
        log('shortcut', accel, e.message);
      }
      // Taken by another app (or refused by the system): Settings says so.
      if (!ok) shortcutProblems.push(key);
    }
    if (shortcutProblems.length) log('shortcuts not available:', shortcutProblems.join(', '));
  }

  function setShortcuts(value) {
    state.shortcuts = { toggle: value.toggle, open: value.open };
    saveState();
    applyShortcuts();
  }

  // The session that needs you most: a question, else a failure, else news; else Claude itself.
  function openMostUrgent() {
    const pick = ['needs-you', 'failed', 'new'].map((s) => latestRows.find((r) => r.state === s)).find(Boolean);
    openSession(pick ? pick.id : '');
  }

  function isDir(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  let drag = null;
  ipcMain.on('drag-start', () => {
    drag = { ...state.anchor };
    applyShape();
  });
  ipcMain.on('drag-move', (_e, d) => {
    if (!drag || !d || !Number.isFinite(d.dx) || !Number.isFinite(d.dy)) return;
    state.anchor = { right: drag.right + d.dx, bottom: drag.bottom + d.dy };
    place();
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    // Keep where it was actually drawn, not where the pointer would have put it off-screen.
    const { b } = bounds();
    state.anchor = { right: b.x + b.width, bottom: b.y + b.height };
    if (ensureVisible()) place();
    saveState();
    applyShape();
  }
  ipcMain.on('drag-end', endDrag);
  ipcMain.on('resize', (_e, h) => {
    if (!validHeight(h)) return;
    cssHeight = h;
    place();
    if (!shownOnce) showFirst();
  });
  ipcMain.on('hover', (_e, over) => setIgnore(!over));
  // Linux: the page's interactive rectangles (CSS pixels), sent on every layout change.
  ipcMain.on('shape', (_e, msg) => {
    if (!isLinux) return;
    const rects = msg && msg.rects;
    if (platform.shapeRects(rects, state.zoom) === null) return;
    shapeCss = rects;
    applyShape();
  });
  ipcMain.on('open', (_e, id) => openSession(String(id || '')));
  ipcMain.on('toggle', () => setCollapsed(!state.collapsed));
  // A right-click mid-drag swallows the button release; end the drag before the menu opens.
  ipcMain.on('menu', () => {
    endDrag();
    showMenu();
  });
  // A right-click on a row: what can be done with that session.
  ipcMain.on('row-menu', (_e, id) => {
    endDrag();
    const row = latestRows.find((r) => r.id === String(id || ''));
    if (!row) return;
    const template = [
      { label: 'Open in Claude', click: () => openSession(row.id) },
      {
        label: 'Open project folder',
        enabled: !!row.folder && isDir(row.folder),
        click: () => shell.openPath(row.folder).then((err) => { if (err) log('could not open folder', err); }),
      },
      { type: 'separator' },
      state.watch === row.id
        ? { label: 'Stop watching', click: () => setWatch('') }
        : { label: 'Watch this session', click: () => setWatch(row.id) },
      row.snoozed
        ? { label: 'Wake it up', click: () => { quiet.unsnooze(row.id); pushRows(); } }
        : {
          label: 'Snooze',
          submenu: [
            { label: 'For 15 minutes', click: () => snooze(row.id, 15) },
            { label: 'For an hour', click: () => snooze(row.id, 60) },
            { label: 'Until it changes', click: () => snooze(row.id, 0) },
          ],
        },
      { type: 'separator' },
      { label: 'Copy link', click: () => clipboard.writeText(sessionUrl(row.id)) },
      { label: 'Copy title', click: () => clipboard.writeText(row.title) },
      ...(row.branch ? [{ label: 'Copy branch', click: () => clipboard.writeText(row.branch) }] : []),
    ];
    Menu.buildFromTemplate(template).popup({ window: win });
  });
  ipcMain.on('ready', () => {
    sentListMax = null;
    place();
    win.webContents.send('collapsed', state.collapsed);
    applyTheme();
    const avatar = loadAvatar(app.getPath('userData'));
    if (avatar) win.webContents.send('avatar', avatar);
    sendMode();
    pushRows();
  });

  // Starting Wilfred again while he runs (or hid him in the tray) brings him back; the Linux
  // launcher's actions ask for something specific.
  app.on('second-instance', (_e, argv) => {
    const command = platform.commandIn(argv);
    if (command === 'quit') return app.quit();
    if (!win) return;
    if (command === 'settings') return openSettings();
    if (command === 'toggle') return setShown(!win.isVisible());
    reassertOverlay();
    setShown(true);
  });
  // A Mac re-launch from Finder, Spotlight or the Dock arrives here, not as a second instance.
  if (isMac) {
    app.on('activate', () => {
      if (!win) return;
      reassertOverlay();
      setShown(true);
    });
  }

  // The GPU process going away can leave the transparent board black or blank: reload it.
  app.on('child-process-gone', (_e, d) => {
    if (d && d.type === 'GPU') recoverBoard(`GPU process gone (${d.reason})`);
  });

  app.whenReady().then(() => {
    // A menu bar app on a Mac: the process must be a UI element before the board exists, or the
    // board can't float over other apps' full-screen Spaces. Dock mode, if on, follows later.
    if (isMac && app.dock) {
      app.dock.hide();
      dockChangedAt = Date.now();
      app.dock.setIcon(nativeImage.createFromPath(asset('wilfred-512.png')));
    }
    // The Mac's menu keys (copy and paste in Settings, Cmd+Q, Cmd+H, Cmd+W) without the default
    // reload and DevTools; Linux gets no menu (and so no menu bar crash on Wayland).
    if (isMac) Menu.setApplicationMenu(Menu.buildFromTemplate(platform.macAppMenu()));
    else if (isLinux) Menu.setApplicationMenu(null);
    lockSession(session.defaultSession);
    const check = verifyNetworkLocked();
    networkCheck = check;
    log(`network: ${check.open.length ? `NOT fully locked (open: ${check.open.join(', ')})` : `locked (${check.blocked.length} ways out blocked)`}`);
    loadState();
    nativeTheme.themeSource = state.appearance;
    notifier = new Notifier(state.notify);
    registerForNotifications(state.notify.on); // on: rewritten if the folder moved; off: leftovers removed
    if (state.notify.on) {
      foldElectronShortcut();
      activatorId(); // read now, so lending it later is one quick write
    }
    journal = new Journal({ dir: journalDir() });
    journal.load();
    journal.prune();
    // The source only reports changes, so a quiet board would go unseen for a minute: the day book
    // looks every 5 s on its own (each look counts at most 10 s, so a sleep never does).
    setInterval(() => {
      const now = Date.now();
      journal.observe(rawRows, now);
      flushJournal(now);
      notify(now); // a question told once it has waited its grace
    }, 5 * 1000);
    applyShortcuts();
    if (isMac) {
      const { version = '' } = packageInfo();
      app.setAboutPanelOptions({ applicationName: 'Wilfred', applicationVersion: version, version, copyright: 'MIT licence' });
    }
    seedThemesFolder();
    applyTheme(); // before the window, so the menu always has a current theme
    if (!demo && !userDataArg && isWindows) renameOldLoginEntry();
    if (!demo && !userDataArg && isMac) refreshMacLogin();
    // Time asleep isn't time a tool spent stuck or a turn spent silent: remember the last sleep.
    // Recent sleeps, so time asleep is never counted as silence (a turn can span several).
    let sleptAt = 0;
    const sleeps = [];
    powerMonitor.on('suspend', () => { sleptAt = Date.now(); });
    powerMonitor.on('resume', () => {
      if (sleptAt) sleeps.push({ from: sleptAt, to: Date.now() });
      sleptAt = 0;
      const horizon = Date.now() - state.windowHours * 3600 * 1000;
      while (sleeps.length && sleeps[0].to < horizon) sleeps.shift();
      // File watchers can lose track during sleep: one full rescan instead of trusting them.
      if (source) source.tick();
      reassertOverlay();
    });
    if (platform.unlockEventSupported(process.platform)) powerMonitor.on('unlock-screen', reassertOverlay);
    createWindow();
    createTray();
    // Re-assert the hide (macOS can drop the first one at startup), or show the Dock in Dock mode,
    // once the startup hide has settled.
    if (isMac) setTimeout(applyDock, 1500);

    // Screens, scaling or the taskbar changed: bring the pet back if it was lost, and refit it;
    // again a moment later, as the work area often settles after the first event.
    const refit = () => {
      reassertOverlay();
      setTimeout(reassertOverlay, 500);
    };
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    screen.on('display-metrics-changed', refit);

    if (isLinux) {
      // Linux: the window's shape decides clicks, but the page still wants to know where the
      // pointer is (hover looks), so tell it whenever the pointer moved over the board.
      let lastCursor = null;
      setInterval(() => {
        if (!win || drag || !win.isVisible()) return;
        const c = screen.getCursorScreenPoint();
        if (lastCursor && c.x === lastCursor.x && c.y === lastCursor.y) return;
        lastCursor = c;
        const point = pagePoint(c, win.getBounds(), state.zoom);
        if (point) win.webContents.send('hover-check', point);
      }, 100);
    } else {
      // Safety net for click-through: if the pointer has left the window, stop catching clicks.
      setInterval(() => {
        if (ignoring || drag || !win) return;
        if (pointInside(screen.getCursorScreenPoint(), win.getBounds())) return;
        setIgnore(true);
        // Tell the page, so the next hover over content switches clicks back on.
        win.webContents.send('hover-reset');
      }, 500);
    }

    if (demo) {
      rawRows = demoRows(Date.now()).sort(compareRows);
      pushRows();
    } else {
      source = new SessionSource({
        windowMs: state.windowHours * 3600 * 1000,
        onRows: (rows) => {
          rawRows = rows;
          pushRows();
        },
        onError: (e) => log('session source error:', e.message),
        sleeps: () => sleeps,
      });
      source.start();
      log(`watching ${rawRows.length} session(s) active in the last ${state.windowHours} h`);
    }
    setInterval(minuteTick, 60 * 1000);

    if (settingsArg || launchCommand === 'settings') openSettings(settingsPage);

    if (screenshotArg) {
      const file = screenshotArg.slice('--screenshot='.length);
      // With --settings, the settings window is the picture; otherwise the board.
      const shoot = async (tries) => {
        try {
          const target = settingsArg ? settingsWin : win;
          if (!target) throw new Error('settings window not open');
          const img = await target.webContents.capturePage();
          if (img.isEmpty()) throw new Error('nothing drawn yet');
          fs.writeFileSync(file, img.toPNG());
          log('screenshot written', file);
        } catch (e) {
          if (tries > 1) setTimeout(() => shoot(tries - 1), 1000);
          else log('screenshot failed', e.message);
        }
      };
      setTimeout(() => shoot(5), 2500);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (source) source.stop();
    if (journal) flushJournal(Date.now(), { force: true });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
