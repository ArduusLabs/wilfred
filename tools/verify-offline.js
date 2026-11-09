// Proves that Wilfred's network lock holds: starts Electron with exactly the lock Wilfred uses
// (src/no-network.js), then tries every way out and reports what happened. Nothing may get through.
//
//   npm run verify-offline
//   npm run verify-offline -- --control   (the same probes with the lock OFF: shows they would work)
//
// Exit code 0 when every attempt was refused, 1 otherwise.
const { lockNetwork, verifyNetworkLocked, lockChromiumSwitches, lockSession } = require('../src/no-network');

const control = process.argv.includes('--control');
// Report a failure of this script on the console, not as a dialog on the screen.
process.on('uncaughtException', (e) => {
  console.error('verify-offline failed:', e);
  process.exit(2);
});
if (!control) lockNetwork();
const { app, BrowserWindow, net, session } = require('electron');

if (!control) lockChromiumSwitches(app);
app.setPath('userData', require('node:path').join(require('node:os').tmpdir(), 'wilfred-verify-offline'));

// A public address and a public name: if either is reachable, the lock has failed.
const TARGETS = ['https://example.com/', 'http://1.1.1.1/'];
// An image probe only tells "reached" from "not" when there is an image at the other end: the
// second target has one, the first doesn't.
const IMAGE = `${TARGETS[1]}favicon.ico`;
const SOCKET = 'wss://example.com/';
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timed out (no connection made)'), ms))]);

app.whenReady().then(async () => {
  if (!control) lockSession(session.defaultSession);
  else console.log('CONTROL RUN: the lock is OFF, so these attempts are expected to get through.\n');
  const results = [];
  const record = (name, outcome, gotThrough) => results.push({ name, outcome, gotThrough });

  // 1. Node in the main process (a control run skips this: unlocked, it would really connect).
  const node = control ? { blocked: [], open: [] } : verifyNetworkLocked();
  for (const name of node.blocked) record(`node: ${name}`, 'blocked', false);
  for (const name of node.open) record(`node: ${name}`, 'NOT blocked', true);

  // 2. Electron's own network module (Chromium's network stack).
  for (const url of TARGETS) {
    const outcome = await withTimeout(net.fetch(url).then((r) => `HTTP ${r.status}`, (e) => `failed: ${e.message}`), 8000);
    record(`electron net.fetch ${url}`, outcome, /^HTTP /.test(outcome));
  }

  // 3. A page with no content security policy at all, so only the session lock can stop it.
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<title>probe</title>');
  const pageProbe = (expr) => withTimeout(win.webContents.executeJavaScript(expr), 8000);
  for (const url of TARGETS) {
    const fetched = await pageProbe(`fetch(${JSON.stringify(url)}, { mode: 'no-cors' }).then(() => 'reached', (e) => 'failed: ' + e.message)`);
    record(`page fetch ${url}`, fetched, fetched === 'reached');
  }
  const image = await pageProbe(`new Promise((r) => { const i = new Image(); i.onload = () => r('reached'); i.onerror = () => r('failed to load'); i.src = ${JSON.stringify(IMAGE)}; })`);
  record(`page image ${IMAGE}`, image, image === 'reached');
  const socket = await pageProbe(`new Promise((r) => { const s = new WebSocket(${JSON.stringify(SOCKET)}); s.onopen = () => r('reached'); s.onerror = () => r('failed to connect'); })`);
  // No server at a documentation address speaks WebSocket, so the control run can't show this one
  // getting through; it says so rather than print a plain "ok".
  record(`page WebSocket ${SOCKET}`, control ? `${socket} (nothing there speaks WebSocket: the control run can't show this one)` : socket, socket === 'reached');
  const beacon = await pageProbe(`String(navigator.sendBeacon('https://example.com/', 'x'))`);
  // sendBeacon only reports whether it queued the request; the request itself goes through (or not)
  // like any other, which the probes above already show.
  record('page sendBeacon https://example.com/', `queued: ${beacon}`, false);
  win.destroy();

  const failed = results.filter((r) => r.gotThrough);
  for (const r of results) console.log(`${r.gotThrough ? 'FAIL' : ' ok '}  ${r.name.padEnd(42)} ${r.outcome}`);
  console.log(failed.length ? `\n${failed.length} way(s) out were NOT blocked.` : `\nAll ${results.length} attempts were refused: Wilfred has no network access.`);
  app.exit(failed.length ? 1 : 0);
});
