// Assembles a runnable Wilfred for one platform from Electron's own build in node_modules/electron/dist.
// The release workflow fetches that build for the target first, with Electron's own installer
// (`node node_modules/electron/install.js` with ELECTRON_INSTALL_PLATFORM and ELECTRON_INSTALL_ARCH),
// which checks the download against the checksums Electron ships. This script downloads nothing and
// runs nothing: it copies Electron, renames its executable, and puts Wilfred beside it, unpacked.
//
//   node tools/package-app.js <win32|darwin|linux> <x64|arm64> <out-dir>
//
// What comes after it is in .github/workflows/release.yml: on Windows the name, icon and version in
// Wilfred.exe (rcedit) and a zip; on a Mac the bundle's Info.plist, an ad-hoc signature and a zip; on
// Linux a tar.gz.

const fs = require('node:fs');
const path = require('node:path');

// Where Electron's executable is in its build, and what Wilfred's is called.
const TARGETS = {
  win32: { electron: 'electron.exe', wilfred: 'Wilfred.exe' },
  darwin: { electron: 'Electron.app/Contents/MacOS/Electron', wilfred: 'Wilfred.app/Contents/MacOS/Electron' },
  linux: { electron: 'electron', wilfred: 'wilfred' },
};
const ARCHES = ['x64', 'arm64'];

// The app, unpacked: Wilfred opens SECURITY.md and reads docs/themes.md from app.getAppPath(), which
// an asar archive would not allow. Linux also gets the launcher and the AppArmor helper.
const SHIP = ['src', 'assets', 'LICENSE', 'README.md', 'SECURITY.md', 'docs/themes.md'];
const SHIP_LINUX = ['start-wilfred.sh', 'tools/linux-apparmor.sh'];

/**
 * The processor an executable is built for, from its header: 'x64', 'arm64', or '' when it is
 * neither (or not an executable). Windows PE, Linux ELF and thin Mach-O, as Electron ships them.
 */
function binaryArch(buf) {
  if (buf.length >= 0x40 && buf.toString('latin1', 0, 2) === 'MZ') {
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return '';
    return { 0x8664: 'x64', 0xaa64: 'arm64' }[buf.readUInt16LE(pe + 4)] || '';
  }
  if (buf.length >= 0x14 && buf.toString('latin1', 0, 4) === '\x7fELF') {
    return { 0x3e: 'x64', 0xb7: 'arm64' }[buf.readUInt16LE(0x12)] || '';
  }
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xfeedfacf) {
    return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[buf.readUInt32LE(4)] || '';
  }
  return '';
}

function readHead(file, bytes = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** The real path of `p` (links, junctions and short names resolved), also when it doesn't exist yet. */
function realPath(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync.native(abs);
  const parent = path.dirname(abs);
  // A drive that doesn't exist (Windows) is its own parent; on other systems / always exists.
  /* node:coverage ignore next */
  if (parent === abs) return abs;
  return path.join(realPath(parent), path.basename(abs));
}

/** Whether `child` is `parent` or inside it. */
function within(child, parent) {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Whether `dir` is a build this script made (so it may be replaced). */
function isBuild(dir) {
  return ['resources', path.join('Wilfred.app', 'Contents', 'Resources')].some((r) => fs.existsSync(path.join(dir, r, 'app', 'package.json')));
}

/**
 * Where a build may go: not over the app, its parents or Electron's own folder; inside the app only
 * under dist/; and over an existing folder only when it is an earlier build (which is replaced).
 */
function checkOut(out, root, electronDir) {
  const o = realPath(out);
  const r = realPath(root);
  const why = within(r, o) ? 'it holds the app itself'
    : within(o, realPath(electronDir)) ? "it is inside Electron's own folder"
    : within(o, r) && !within(o, path.join(r, 'dist')) ? "inside the app, builds go under dist/"
    : fs.existsSync(o) && !isBuild(o) ? 'it exists and is not an earlier build'
    : '';
  if (why) throw new Error(`refusing to build into ${out}: ${why}`);
}

/**
 * Builds Wilfred for `platform`/`arch` in `out` from the Electron build in `electronDir` (its
 * `dist` folder and `path.txt`) and the app in `root`. Throws when the build is for another
 * platform or processor, or when `out` isn't a safe place for it (see checkOut). Returns the
 * executable's path.
 */
function assemble({ root, electronDir, platform, arch, out }) {
  const target = TARGETS[platform];
  if (!target) throw new Error(`unknown platform "${platform}" (win32, darwin or linux)`);
  if (!ARCHES.includes(arch)) throw new Error(`unknown processor "${arch}" (x64 or arm64)`);
  checkOut(out, root, electronDir);

  const dist = path.join(electronDir, 'dist');
  let installed = '';
  try {
    installed = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8');
  } catch {
    // no Electron build at all: said below
  }
  if (installed !== target.electron) throw new Error(`node_modules/electron/dist is not the ${platform} build: run Electron's install.js for it first`);
  const found = binaryArch(readHead(path.join(dist, target.electron)));
  if (found !== arch) throw new Error(`node_modules/electron/dist is built for "${found || 'something else'}", not ${arch}`);

  fs.rmSync(out, { recursive: true, force: true });
  // Symlinks stay links: the Mac frameworks are made of them, and copied as files the bundle breaks.
  fs.cpSync(dist, out, { recursive: true, verbatimSymlinks: true });

  let resources;
  if (platform === 'darwin') {
    // The executable inside is renamed by release.yml, with the Info.plist that names it.
    fs.renameSync(path.join(out, 'Electron.app'), path.join(out, 'Wilfred.app'));
    resources = path.join(out, 'Wilfred.app', 'Contents', 'Resources');
  } else {
    fs.renameSync(path.join(out, target.electron), path.join(out, target.wilfred));
    resources = path.join(out, 'resources');
  }
  // Electron's sample app and its version stamp are not Wilfred's. LICENSE and LICENSES.chromium.html
  // stay where Electron put them: their licences ask for them to ship with every copy.
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  fs.rmSync(path.join(out, 'version'), { force: true });

  const app = path.join(resources, 'app');
  for (const rel of platform === 'linux' ? [...SHIP, ...SHIP_LINUX] : SHIP) {
    fs.cpSync(path.join(root, rel), path.join(app, rel), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  delete pkg.devDependencies; // nothing to install in a built app
  delete pkg.scripts;
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return path.join(out, target.wilfred);
}

module.exports = { TARGETS, SHIP, SHIP_LINUX, binaryArch, assemble };

/* node:coverage disable */
if (require.main === module) {
  const [platform, arch, out] = process.argv.slice(2);
  if (!platform || !arch || !out) {
    console.error('usage: node tools/package-app.js <win32|darwin|linux> <x64|arm64> <out-dir>');
    process.exit(2);
  }
  const root = path.join(__dirname, '..');
  try {
    const exe = assemble({ root, electronDir: path.join(root, 'node_modules', 'electron'), platform, arch, out });
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    console.log(`Wilfred ${version} for ${platform} ${arch}: ${path.relative(process.cwd(), exe)}`);
  } catch (e) {
    console.error(`package-app: ${e.message}`);
    process.exit(1);
  }
}
/* node:coverage enable */
