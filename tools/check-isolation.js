// Wilfred's isolation check. Runs in CI on every change and fails it if anything could let Wilfred
// (or its build) send data anywhere. Run it yourself with `npm run check-isolation`.
//
// What it enforces, file by file:
// - each file may load only the modules on its allowlist; network modules only in no-network.js,
//   which loads them to switch them off
// - no network-capable code: fetch, XMLHttpRequest, WebSocket, sendBeacon, eval, dynamic import(),
//   non-literal require(), Electron security switches turned off, loading remote pages
// - no URLs to outside hosts (namespace identifiers and documentation addresses aside)
// - main.js locks the network before it loads anything else
// - the page keeps its strict content security policy
// - no runtime dependencies, no install scripts, and only the reviewed packages (exact versions)
//   in the lockfile, all from the npm registry
// - CI workflows are read-only and pin every action to a full commit hash; the one exception is
//   the release workflow's job that publishes the release, which may write the repository's
//   contents (the tag and the release) and nothing else
//
// Changing an allowlist here, or security/allowed-packages.json, is a visible change that the
// maintainers review on its own.

const fs = require('node:fs');
const path = require('node:path');

const NODE_SAFE = ['node:fs', 'node:os', 'node:path'];
const NETWORK_MODULES = ['node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:http', 'node:https', 'node:http2'];
// nativeTheme: the settings' light/dark choice (themeSource); it has no way out.
// Notification: the operating system's own notices, shown on this machine. globalShortcut: the
// keyboard shortcuts you choose in Settings. clipboard: "Copy …" items, on your click only.
const ELECTRON_SAFE = ['app', 'BrowserWindow', 'ipcMain', 'Menu', 'Tray', 'nativeImage', 'nativeTheme', 'Notification', 'globalShortcut', 'clipboard', 'powerMonitor', 'screen', 'session', 'shell', 'contextBridge', 'ipcRenderer'];

// Per file: which modules it may require, and which Electron APIs it may take.
const RULES = {
  'src/no-network.js': { modules: NETWORK_MODULES, electron: [] },
  'src/main.js': { modules: [...NODE_SAFE, 'electron', './no-network', './login-mac', './login-linux', './platform', './sessions/source', './demo', './renderer/view', './sessions/status', './window-logic', './themes', './quiet', './notify', './shortcuts', './journal'], electron: ELECTRON_SAFE, mayOpenExternal: true },
  'src/preload.js': { modules: ['electron'], electron: ['contextBridge', 'ipcRenderer'] },
  'src/settings-preload.js': { modules: ['electron'], electron: ['contextBridge', 'ipcRenderer'] },
  'src/window-logic.js': { modules: [...NODE_SAFE, './shortcuts', './notify'], electron: [] },
  'src/themes.js': { modules: [...NODE_SAFE, './window-logic'], electron: [] },
  'src/login-mac.js': { modules: NODE_SAFE, electron: [] },
  'src/login-linux.js': { modules: NODE_SAFE, electron: [] },
  'src/platform.js': { modules: NODE_SAFE, electron: [] },
  'src/quiet.js': { modules: [], electron: [] },
  'src/notify.js': { modules: ['./sessions/transcript'], electron: [] },
  'src/shortcuts.js': { modules: [], electron: [] },
  'src/journal.js': { modules: NODE_SAFE, electron: [] },
  'src/demo.js': { modules: [], electron: [] },
  'src/sessions/source.js': { modules: [...NODE_SAFE, './transcript', './status'], electron: [] },
  'src/sessions/transcript.js': { modules: NODE_SAFE, electron: [] },
  'src/sessions/status.js': { modules: ['./transcript'], electron: [] },
  'src/renderer/view.js': { modules: [], electron: [] },
  'src/renderer/renderer.js': { modules: [], electron: [] },
  'src/renderer/settings.js': { modules: [], electron: [] },
  'tools/make-icons.js': { modules: [...NODE_SAFE, 'electron', './icon-files'], electron: ['app', 'BrowserWindow'] },
  'tools/icon-files.js': { modules: [], electron: [] },
  // Copies Electron's build and the app into a folder; the release workflow does the downloading.
  'tools/package-app.js': { modules: ['node:fs', 'node:path'], electron: [] },
  // Looks at the real app from inside Electron (loaded ahead of it): no way out of its own.
  'tools/ui-check.js': { modules: ['electron', 'node:fs', 'node:os', 'node:path', './ui-rules'], electron: ['app', 'BrowserWindow', 'Menu', 'nativeTheme'] },
  'tools/ui-rules.js': { modules: [], electron: [] },
  // Reads a pull request's description from the event file CI hands it, and the template.
  'tools/check-pr.js': { modules: ['node:fs', 'node:path'], electron: [] },
  // The proof tool tries every way out on purpose (that is its job), against the lock.
  'tools/verify-offline.js': { modules: ['../src/no-network', 'electron', 'node:path', 'node:os'], electron: ['app', 'BrowserWindow', 'net', 'session'], probesNetwork: true },
  // This file lists the forbidden patterns, so it is exempt from scanning for them (its imports are
  // still checked); changes to it are reviewed by the maintainers (see .github/CODEOWNERS).
  'tools/check-isolation.js': { modules: NODE_SAFE, electron: [], listsPatterns: true },
};

// Network-capable or code-loading constructs, with the files allowed to mention them.
const FORBIDDEN = [
  // no-network.js calls the (already blocked) fetch in its self-test, to prove it is blocked.
  { re: /\bfetch\s*\(/, what: 'fetch()', allow: ['tools/verify-offline.js', 'src/no-network.js'] },
  { re: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { re: /\bnew\s+WebSocket\b/, what: 'WebSocket', allow: ['tools/verify-offline.js'] },
  { re: /\bEventSource\b/, what: 'EventSource', allow: ['src/no-network.js'] },
  { re: /\bsendBeacon\b/, what: 'navigator.sendBeacon', allow: ['tools/verify-offline.js'] },
  { re: /\bimportScripts\b/, what: 'importScripts' },
  { re: /\beval\s*\(/, what: 'eval()' },
  { re: /\bnew\s+Function\b/, what: 'new Function()' },
  { re: /\bimport\s*\(/, what: 'dynamic import()' },
  { re: /\bprocess\.binding\b/, what: 'process.binding' },
  { re: /\bcreateRequire\b/, what: 'module.createRequire' },
  { re: /\bloadURL\s*\(/, what: 'loading a remote page (loadURL)', allow: ['tools/verify-offline.js'] },
  { re: /\bopenExternal\s*\(/, what: 'shell.openExternal', allowIf: 'mayOpenExternal' },
  { re: /nodeIntegration\s*:\s*true/, what: 'nodeIntegration: true' },
  { re: /contextIsolation\s*:\s*false/, what: 'contextIsolation: false' },
  { re: /sandbox\s*:\s*false/, what: 'sandbox: false' },
  { re: /webSecurity\s*:\s*false/, what: 'webSecurity: false' },
  { re: /allowRunningInsecureContent/, what: 'allowRunningInsecureContent' },
  { re: /webviewTag\s*:\s*true/, what: 'webviewTag: true' },
];

// URLs that appear in the code but are never fetched: XML namespaces, a DTD identifier, and
// documentation-only addresses (RFC 5737, RFC 2606) that the lock's own self-test aims at.
const URL_ALLOWED = [
  'http://www.w3.org/2000/svg',
  'http://www.apple.com/DTDs/PropertyList-1.0.dtd',
  /^https?:\/\/192\.0\.2\.\d+(:\d+)?\/?$/,
  /^https?:\/\/example\.(com|invalid)\/?$/,
  /^wss:\/\/example\.com\/?$/,
  /^http:\/\/1\.1\.1\.1\/?$/,
  // The project page, which About opens in your browser on a click (see ALLOWED_EXTERNAL); named
  // here so a test or a doc may say it. Wilfred never fetches it.
  'https://github.com/ArduusLabs/wilfred',
  'https://github.com/ArduusLabs/wilfred#readme',
];
const URL_ONLY_IN = { '^https?:\\/\\/example': ['tools/verify-offline.js'], '^wss:': ['tools/verify-offline.js'], '^http:\\/\\/1\\.1': ['tools/verify-offline.js'] };

const EXPECTED_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:";
const ALLOWED_DEV_DEPENDENCIES = ['electron'];
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'];

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Strips // and /* *\/ comments (keeping line breaks), so prose about fetch() isn't flagged. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Problems in one JavaScript file. */
function checkSource(file, text) {
  const problems = [];
  const rule = RULES[file];
  if (!rule) return [`${file}: not on the isolation allowlist (add it to RULES in tools/check-isolation.js, reviewed)`];
  const code = stripComments(text);

  for (const m of code.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) {
    const arg = m[1].trim();
    const literal = /^(['"])([^'"]+)\1$/.exec(arg);
    if (!literal) {
      if (rule.listsPatterns) continue;
      problems.push(`${file}:${lineOf(code, m.index)}: require() with a non-literal argument`);
      continue;
    }
    if (!rule.modules.includes(literal[2])) problems.push(`${file}:${lineOf(code, m.index)}: may not load "${literal[2]}"`);
  }
  for (const m of code.matchAll(/^\s*import\s.+from\s+['"]([^'"]+)['"]/gm)) {
    if (!rule.modules.includes(m[1])) problems.push(`${file}:${lineOf(code, m.index)}: may not import "${m[1]}"`);
  }
  for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]electron['"]\s*\)/g)) {
    for (const name of m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean)) {
      if (!rule.electron.includes(name)) problems.push(`${file}:${lineOf(code, m.index)}: may not use Electron's "${name}"`);
    }
  }
  if (rule.listsPatterns) return problems;
  for (const f of FORBIDDEN) {
    if (f.allow && f.allow.includes(file)) continue;
    if (f.allowIf && rule[f.allowIf]) continue;
    const m = f.re.exec(code);
    if (m) problems.push(`${file}:${lineOf(code, m.index)}: ${f.what} is not allowed`);
  }
  for (const m of text.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)<>]+/g)) {
    const url = m[0].replace(/[.,;]+$/, '');
    const ok = URL_ALLOWED.some((a) => (typeof a === 'string' ? a === url : a.test(url)));
    const restricted = Object.entries(URL_ONLY_IN).find(([re]) => new RegExp(re).test(url));
    if (!ok || (restricted && !restricted[1].includes(file))) problems.push(`${file}:${lineOf(text, m.index)}: URL to an outside host: ${url}`);
  }
  return problems;
}

/** main.js must lock the network before it loads anything else. */
function checkLockFirst(text) {
  const code = stripComments(text);
  const lockAt = code.search(/\blockNetwork\(\)/);
  const firstOther = code.search(/require\(\s*['"](?!\.\/no-network['"])/);
  if (lockAt < 0) return ['src/main.js: never calls lockNetwork()'];
  if (firstOther >= 0 && firstOther < lockAt) return [`src/main.js:${lineOf(code, firstOther)}: loads a module before lockNetwork()`];
  return [];
}

/** The page's content security policy, and nothing loaded from outside. */
function checkHtml(file, text) {
  const problems = [];
  const csp = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]*)"/i.exec(text);
  if (!csp) problems.push(`${file}: content security policy is missing`);
  else if (csp[1] !== EXPECTED_CSP) problems.push(`${file}: content security policy changed to "${csp[1]}"`);
  for (const m of text.matchAll(/\b(?:src|href)\s*=\s*"(?!data:)([^"]*:[^"]*)"/gi)) {
    problems.push(`${file}:${lineOf(text, m.index)}: loads from outside: ${m[1]}`);
  }
  return problems;
}

/** Dependencies: none at run time, no install scripts, only reviewed packages from the npm registry. */
function checkPackages(pkg, lock, allowed) {
  const problems = [];
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) problems.push(`package.json: runtime dependencies are not allowed (${Object.keys(pkg.dependencies).join(', ')})`);
  for (const name of Object.keys(pkg.devDependencies || {})) {
    if (!ALLOWED_DEV_DEPENDENCIES.includes(name)) problems.push(`package.json: devDependency "${name}" is not allowed`);
  }
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json: "${name}" must be pinned to an exact version, not "${version}"`);
  }
  for (const hook of INSTALL_HOOKS) if (pkg.scripts && pkg.scripts[hook]) problems.push(`package.json: "${hook}" script is not allowed`);
  const found = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key) continue;
    const name = key.replace(/^.*node_modules\//, '');
    found.push(`${name}@${entry.version}`);
    if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) problems.push(`package-lock.json: ${name} comes from ${entry.resolved}`);
    if (entry.resolved && !entry.integrity) problems.push(`package-lock.json: ${name} has no integrity hash`);
  }
  const want = new Set(allowed);
  for (const f of found) if (!want.has(f)) problems.push(`package-lock.json: ${f} is not in security/allowed-packages.json`);
  for (const a of allowed) if (!found.includes(a)) problems.push(`security/allowed-packages.json: ${a} is no longer in the lockfile (remove it)`);
  return problems;
}

// The release workflow, and the one write it may grant: its job named `release` may write the
// repository's contents (the tag and the release). Nothing else may be written, anywhere.
const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const RELEASE_JOB = 'release';

/**
 * A workflow's lines as YAML structure: comments removed, and the contents of block scalars
 * (`run: |` scripts, `>` text) blanked, since they are text, not keys. Line numbers are kept.
 */
function structureLines(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let blockIndent = -1;
  return lines.map((line) => {
    const indent = line.search(/\S/);
    if (blockIndent >= 0 && (indent < 0 || indent > blockIndent)) return '';
    blockIndent = -1;
    const code = line.replace(/(^|\s)#.*$/, '').replace(/\s+$/, '');
    if (/(:|^\s*-)\s+[|>][-+0-9]*$/.test(code)) blockIndent = indent;
    return code;
  });
}

// Outside scripts, a workflow is written in plain YAML, so that a permission can be read off the
// text: none of these, which could spell a key or a value in a way this check can't see.
const UNREADABLE = [
  { re: /\\/, what: 'a backslash (escapes and line continuations)' },
  { re: /^\s*(-\s+)?\?(\s|$)/, what: 'a complex key ("?")' },
  { re: /(^|[\s,{[])["'][^"']*["']?\s*:(\s|$)|^\s*(-\s+)?["']/, what: 'a quoted key or a quoted line start' },
  { re: /(^|[\s,{[:-])([&*][\w-]|![!<\w])/, what: 'an anchor, alias or tag (&, *, !)' },
  { re: /^[^#]*[{[][^}\]]*$/, what: 'a flow collection over several lines' },
];

/** CI: read-only, the release job's one write aside, and every action pinned to a full commit. */
function checkWorkflow(file, text) {
  const problems = [];
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(text)) problems.push(`${file}: must declare "permissions: contents: read" at the top`);
  const release = file === RELEASE_WORKFLOW;
  // Every permissions key must be one of two block forms, each entry a plain `scope: value` line:
  //   permissions:            (column 0: the workflow's own)    jobs:
  //     contents: read                                            <job>:        (2 spaces, a plain name)
  //                                                                 permissions:  (4 spaces)
  //                                                                   contents: read
  // Values are read or none; write only for contents, only in the release workflow's `release` job.
  const lines = structureLines(text);
  let inJobs = false;
  let job = '';
  let block = -1; // indent of the permissions key whose entries follow, or -1
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (!line.trim()) return;
    const indent = line.search(/\S/);
    for (const u of UNREADABLE) if (u.re.test(line)) problems.push(`${at}: written in a form the isolation check can't read: ${u.what}`);
    if (block >= 0 && indent > block) {
      const entry = new RegExp(`^ {${block + 2}}([a-z-]+): (read|write|none)$`).exec(line);
      if (!entry) return problems.push(`${at}: a permission must be a plain "scope: read" line under its block`);
      if (entry[2] !== 'write') return;
      if (release && job === RELEASE_JOB && block === 4 && entry[1] === 'contents') return;
      return problems.push(`${at}: grants write permission${release ? ` (only the "${RELEASE_JOB}" job's own "contents: write" may)` : ''}`);
    }
    block = -1;
    if (indent === 0) {
      inJobs = line === 'jobs:';
      job = '';
    } else if (inJobs && indent <= 2) {
      const key = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
      if (!key) problems.push(`${at}: a job must be a plain name on its own line, two spaces in`);
      job = key ? key[1] : '';
    }
    if (!/(^|[\s{,-])permissions\s*:/.test(line)) return;
    if (line === 'permissions:' || (job && line === '    permissions:')) block = indent;
    else problems.push(`${at}: permissions must be a block at the top or in a job (two spaces in), entries on their own lines`);
  });
  // And, as before, no write spelled out anywhere else in the file (scripts included).
  if (problems.length === 0) {
    const rest = text.replace(/^ {6}contents: write\s*(#.*)?\r?$/m, '');
    for (const m of rest.matchAll(/:\s*["']?write\b/g)) problems.push(`${file}:${lineOf(rest, m.index)}: grants write permission`);
  }
  for (const m of text.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(m[2])) problems.push(`${file}:${lineOf(text, m.index)}: ${m[1]} must be pinned to a full commit hash, not "${m[2]}"`);
  }
  return problems;
}

function listFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Every problem in the repository at `root`. */
function checkRepo(root) {
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const problems = [];
  for (const file of [...listFiles(path.join(root, 'src'), ['.js']), ...listFiles(path.join(root, 'tools'), ['.js'])]) {
    problems.push(...checkSource(rel(file), fs.readFileSync(file, 'utf8')));
  }
  problems.push(...checkLockFirst(read('src/main.js')));
  for (const file of listFiles(path.join(root, 'src'), ['.html'])) problems.push(...checkHtml(rel(file), fs.readFileSync(file, 'utf8')));
  problems.push(...checkPackages(JSON.parse(read('package.json')), JSON.parse(read('package-lock.json')), JSON.parse(read('security/allowed-packages.json'))));
  const wf = path.join(root, '.github', 'workflows');
  for (const file of listFiles(wf, ['.yml', '.yaml'])) problems.push(...checkWorkflow(rel(file), fs.readFileSync(file, 'utf8')));
  return problems;
}

module.exports = { checkRepo, checkSource, checkLockFirst, checkHtml, checkPackages, checkWorkflow, stripComments, RULES, EXPECTED_CSP, RELEASE_WORKFLOW };

/* node:coverage disable */
if (require.main === module) {
  const problems = checkRepo(path.join(__dirname, '..'));
  if (problems.length) {
    console.error(`Isolation check FAILED (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Isolation check passed: no network-capable code, no new dependencies, CI locked down.');
}
/* node:coverage enable */
