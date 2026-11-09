# What other overlays taught Wilfred

Wilfred is a transparent, frameless, always-on-top window that is mostly click-through. Other
Electron apps of that shape (desktop pets, crosshair and game overlays, head-tracking HUDs,
menu-bar companions) have hit the same walls for years, and Electron's own documentation and
issue tracker record the rest. This page lists what was learned from them and what Wilfred does
about each, so a contributor can see why the odd-looking lines in `src/main.js` and
`src/platform.js` are there. Nothing on the macOS and Linux lists has been run on those systems
by the author yet; it is built from the evidence, and reports are welcome.

## Everywhere

| What goes wrong | What Wilfred does | Where |
| --- | --- | --- |
| A frameless window gets rounded corners (Windows 11, Linux 43+), which clip the transparent room kept for the shadow | `roundedCorners: false` | `platform.boardWindowOptions` |
| The window flashes white before the page draws | `backgroundColor: '#00000000'`, `show: false`, shown only when the page has reported its height | same, `createWindow` |
| Showing or focusing the overlay steals focus from what you are typing in | only `showInactive()`, never `show()` or `focus()`, and `focusable: false` | `setShown` |
| After sleep, a lock, a display change or an Explorer restart the window loses "always on top", comes back in the taskbar, or leaves its Space | `reassertOverlay()` on resume, unlock, every display event (and again 500 ms later), and when a second launch pokes him | `reassertOverlay` |
| A crashed renderer or GPU process leaves an invisible, unclickable window that looks like Wilfred quit | reload on `render-process-gone` and GPU `child-process-gone`, at most one every 2 s and five in 30 s | `recoverBoard`, `platform.reloadPlan` |
| Moving between monitors with different scaling grows the window on Windows (an open Electron issue) | every size comes from the saved state, never from `getBounds()`; the same bounds are set twice when the display changes | `setBoardBounds` |
| A window left on an unplugged monitor is lost | the anchor is checked against the connected screens and brought back to the main one | `ensureVisible` |
| File watchers lose sync across sleep | one full rescan on resume, and the session source polls rather than trusting events | `powerMonitor.on('resume')` |
| Idle animations in an always-visible transparent window cost GPU time | motion is `transform`/`opacity` only, decorative motion stops under reduced motion, and the sleeping butler barely moves | `style.css` |

## Windows

| What goes wrong | What Wilfred does | Where |
| --- | --- | --- |
| A toast is named after the Start Menu shortcut that carries the app's AppUserModelID. Electron (44, `windows_toast_activator.cc`) writes one itself, on a background thread, from a process's first touch of `Notification` (`isSupported()` included), in the user's Start Menu, named after the exe's product name ("Electron" from a checkout), pointing at the bare exe, with the id and a toast activator CLSID it mints unless the file already holds one (also recorded under `HKCU\Software\Classes\CLSID`); it rewrites the file whenever target, folder, id or CLSID differ, and only a packaged (MSIX) app is spared. Two entries for one id, and Windows picks either | `app.setAppUserModelId` first. While notifications are on: Wilfred's own entry (`Wilfred.lnk`: the id, his `.ico`, the Electron-plus-app-folder command, and the activator CLSID once known), written with `shell.writeShortcutLink` and rewritten if the folder moved; before the first touch of `Notification` in a run, Electron's entry is written for it with the known CLSID (remembered in `state.json`, so Electron keeps one activator id instead of minting one per run), and 1.5 s and 6 s after a toast, that entry is folded into Wilfred's (CLSID adopted) and removed. Switching off removes both; an entry named Wilfred that isn't his is left alone, and then Electron's stays so the id keeps a name. Measured on Windows 11: the id survives restarts and off-and-on; Windows re-attributes within seconds to minutes after the entries change, and relabels earlier toasts in the notification centre | `registerForNotifications`, `lendElectronShortcut`, `foldElectronShortcut`, `platform.startMenuShortcut`, `platform.electronShortcut` |
| A toast about the session you are looking at is noise | a question or a result waits 30 s before it's told; answered or seen sooner, nothing is said | `notify.js` (`GRACE_MS`) |

## macOS

| What goes wrong | What Wilfred does | Where |
| --- | --- | --- |
| A window only floats over another app's full-screen Space if the process was already a UI element (no Dock icon) when the window was created | `app.dock.hide()` first, the window after; re-asserted 1.5 s later because the first hide can be dropped at startup | `whenReady`, `applyDock` |
| `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` transforms the process again and blinks the window and Dock | `skipTransformProcessType: true` | `joinAllSpaces` |
| The first click on an inactive app's window only activates it | `acceptFirstMouse: true`; also `hiddenInMissionControl: true`, `fullscreenable: false` | `platform.boardWindowOptions` |
| A coloured menu-bar icon doesn't follow light and dark menu bars | a template image pair (`trayTemplate.png`, `@2x`), black with alpha; a fixed id keeps its place | `tools/make-icons.js`, `createTray` |
| A quick second click on the menu-bar icon is a double click and the toggle is lost; Ctrl-click isn't a right click | `setIgnoreDoubleClickEvents(true)`; Ctrl-click opens the menu | `createTray` |
| Without an application menu, Cmd+C/V/Q don't work; the default one adds Cmd+R reload and DevTools | an explicit menu with the app, edit and window roles | `platform.macAppMenu` |
| Re-launching from Finder or Spotlight doesn't reach `second-instance` | `app.on('activate')` brings him back | `start()` |
| Electron's login item would start bare Electron, not Wilfred | a per-user LaunchAgent that runs Electron on Wilfred's folder: graphical session only, an app's priority, a log file, your `CLAUDE_CONFIG_DIR`, mode 0644 (launchd skips a group-writable file), never `KeepAlive` (quitting must stay quit), rewritten when the folder moves | `login-mac.js` |
| Since Electron 42 the binary is fetched on first use, so `npm install` may leave no `Electron.app`; `nohup` from Terminal keeps the window open and charges privacy prompts to Terminal | `start-wilfred.command` fetches the binary if missing and starts him with `open -n -a … --args` | `start-wilfred.command` |
| Transparent windows can leave shadow ghosts | `hasShadow: false` (the shadow is CSS) and `invalidateShadow()` after each move | `setBoardBounds` |
| An unpackaged app is "Electron" to the system (Dock label, notifications, privacy prompts), and unsigned apps' notifications can fail | the icon and About panel are set at runtime; notifications are best-effort with a `failed` handler; the README says what the system will call him | `whenReady`, `notify` |
| `dock.setBadge` and friends do nothing while the Dock icon is hidden | Dock mode is a setting; off, the count shows beside the menu-bar icon | `updateBadges`, `platform.badgePlaces` |

## Linux

| What goes wrong | What Wilfred does | Where |
| --- | --- | --- |
| Since Electron 38 a Wayland session gets a native Wayland window, which can't be placed, kept on top or follow the pointer; the switch to avoid it only works on the real command line | `start-wilfred.sh` passes `--ozone-platform=x11`; `main.js` relaunches itself once with it when it finds itself on Wayland with an X server at hand (`WILFRED_WAYLAND=1` opts out) | `platform.relaunchForX11` |
| `setIgnoreMouseEvents(…, { forward: true })` has no `forward` on Linux: once click-through, the page never sees the pointer again and Wilfred can't be clicked | the page reports the rectangles of its content and the window is shaped to them (`setShape`); the whole window while dragging; a cursor poll feeds hover looks | `applyShape`, `renderer.js reportShape` |
| The tray has no right-click event and no pop-up menu; `click` may never fire; GNOME shows no tray without an extension | the menu is attached with `setContextMenu` and re-attached when it changes, with Show/Hide as its first item; everything is also on the pet's own menu, in Settings and on the launcher's actions | `refreshTrayMenu`, `platform.trayBehaviour` |
| Ubuntu 24.04+ restricts user namespaces, so Chromium's sandbox fails and Electron aborts; the easy fix, `--no-sandbox`, is the wrong one for a privacy app | the launcher detects it and points at `tools/linux-apparmor.sh`, which installs a one-paragraph AppArmor profile for this folder's Electron (Ubuntu's own recommended way); `--no-sandbox` appears nowhere, and a test keeps it so | `start-wilfred.sh`, `tools/linux-apparmor.sh` |
| Electron's login items don't exist on Linux | an XDG autostart entry, started a few seconds after login so the compositor is up (without one the window is black); switching it off in GNOME Tweaks is respected | `login-linux.js` |
| The Settings window shows a generic icon and name; launcher badges need a matching desktop entry | `app.setDesktopName('wilfred.desktop')`, and an app-menu entry with Show/Settings/Quit actions you can install from Settings | `platform.launcherFiles` |
| A framed window with the default menu crashed on native Wayland in some 44.x builds | `Menu.setApplicationMenu(null)` on Linux | `whenReady` |
| `setContentProtection` is Windows/macOS only | skipped on Linux, and Settings says so | `protect` |
| `focusable: false` makes the window unmanaged on X11 | that is wanted: no taskbar entry, every workspace, exact placement; `skipTaskbar` is a no-op there | `platform.reassertPlan` |

## Old advice that no longer applies to Electron 44

`--enable-transparent-visuals --disable-gpu` and "create the window 300 ms after ready" (2014-era
Linux transparency), the 1 px border and smearing of transparent windows on Linux (fixed in 41.2),
the macOS Tahoe WindowServer lag (fixed in 38.2), the throttling of windows under a click-through
overlay on macOS (fixed in 44.0), `--force-device-scale-factor=1` (blurs everything), and native
click-through add-ons. None of them is in Wilfred, on purpose.
