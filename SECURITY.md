# Security

## What Wilfred promises

Wilfred reads your Claude sessions to show their status. It **never sends anything anywhere**:

- **No network at all.** At startup, before loading anything else, Wilfred switches off every
  way its process could connect out (sockets, DNS, HTTP, `fetch`, WebSockets), and Chromium's
  networking with it. This is enforced in code (`src/no-network.js`), not just promised.
- **Read-only.** Wilfred reads the Claude app's session files and Claude Code's transcripts. It
  writes only inside its own settings folder: `state.json`; in `themes/` a copy of each built-in
  theme for you to edit (plus any theme you ask it to save there); and in `journal/` one small file
  per day (session titles, projects, times and counts: the day book), kept for 30 days. The only
  files it writes anywhere else are the ones you ask for by name in Settings, each removed when
  you switch it off: the start-at-login entry (a Windows startup entry, a LaunchAgent on a Mac, an
  autostart entry on Linux); on Linux, the app-menu entry with its icon; and on Windows, while
  notifications are on, a Start Menu entry for Wilfred, which is what gives them his name. (On
  Windows, Electron itself writes a Start Menu entry named "Electron" for the same id when a process
  sends its first notification, and records its activator in the registry under
  `HKCU\Software\Classes\CLSID`; Wilfred folds that entry into his own and removes it, and remembers
  the activator id in his settings so it stays the same from run to run and there is one registry
  record, which he doesn't remove. The downloaded `Wilfred.exe` does none of that: the entry Electron
  writes for it is already named Wilfred, and it stays when notifications are switched off.)
- **Opens nothing but two addresses, and only when you click.** A session link (`claude://…`, the
  Claude app's own) when you click a row, and the project's page on GitHub when you press the button
  in Settings > About. Both are handed to the operating system to open; Wilfred itself connects to
  nothing. "Open project folder" in a row's menu opens a local folder in your file manager.
- **Tells only you.** Notifications are off until you switch them on. They are your operating
  system's own, shown on this computer; they can carry the session's question (switch that off in
  Settings > Notifications for shared screens).
  The "Copy" items put text on your clipboard, on your click. Keyboard shortcuts are registered with
  the operating system only when you pick one.
- **No hooks, no changes to Claude.** It doesn't touch `~/.claude/settings.json` or the Claude app.
- **No dependencies at run time.** The only package is Electron itself, pinned to an exact version.

## How it's kept that way

Every change to the repository is checked by `tools/check-isolation.js` in CI. A change fails if it:

- loads a network module, or any module a file isn't allowed to load;
- uses network-capable code (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `eval`,
  dynamic `import()`, loading remote pages), or turns off an Electron security setting;
- contains a URL to an outside host;
- moves the network lock away from the very start of `src/main.js`;
- weakens the page's content security policy;
- adds a runtime dependency, an install script, or any package (or version) not listed in
  `security/allowed-packages.json`, or one fetched from anywhere but the npm registry;
- gives a CI workflow write access or uses an action not pinned to a full commit hash. The one
  write allowed is in the release workflow (`.github/workflows/release.yml`): its last job, which
  publishes the release, may write the repository's contents (that is, create the tag and the
  release) and nothing else, granted to that job alone; every other job there, and every other
  workflow, stays read-only. So that this can be read off the text, a workflow's permissions must be
  written in YAML's plain block form, and outside its scripts a workflow may not use the YAML features
  that could spell a key or value another way (escapes, quoted or complex keys, anchors, aliases and
  tags). No workflow uses secrets.

The downloads on the releases page are built by that workflow from the commit their release names,
with no packages beyond Electron: Electron's own build for each system (checked against the
checksums Electron ships), Wilfred's files copied beside it unchanged, and on Windows Electron's
`rcedit` tool (checked against a SHA-256 in the workflow) to set the name and icon. They are not
signed.

The check is part of `npm test` too, so it also runs on every contributor's machine.

## Check it yourself

```bash
npm run verify-offline
```

This starts Electron with exactly Wilfred's lock and tries every way out: TCP, TLS, UDP, DNS, HTTP,
HTTP/2, Node's `fetch`, Electron's own network module, and a page's `fetch`, images and
WebSockets. Every attempt must be refused. `npm run verify-offline -- --control` runs the same
attempts with the lock off, to show they would otherwise succeed.

When Wilfred itself starts, it logs `network: locked (9 ways out blocked)`, and its menu shows the
result with a green mark: **Privacy check passed: Wilfred can't reach any network**.

## For maintainers

On GitHub, protect `main` so the guarantees above can't be bypassed:

- require a pull request, with a review from Code Owners (`.github/CODEOWNERS`);
- require the **isolation** and **test** checks to pass;
- don't allow force pushes, and include administrators.

## Reporting a vulnerability

If you find a way Wilfred could send data off your machine, or any other security problem, please
report it privately through GitHub's **Report a vulnerability** button (Security tab), rather than
in a public issue.
