// tools/package-app.js: Wilfred assembled from an Electron build, here a fake one in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../tools/package-app');

const ROOT = path.join(__dirname, '..');

// The first bytes of an executable for each system and processor, as their headers have them.
function pe(machine) {
  const b = Buffer.alloc(0x100);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(machine, 0x84);
  return b;
}
function elf(machine) {
  const b = Buffer.alloc(0x40);
  b.write('\x7fELF', 0, 'latin1');
  b.writeUInt16LE(machine, 0x12);
  return b;
}
function macho(cpu) {
  const b = Buffer.alloc(0x20);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}
const HEADERS = {
  win32: { x64: pe(0x8664), arm64: pe(0xaa64) },
  linux: { x64: elf(0x3e), arm64: elf(0xb7) },
  darwin: { x64: macho(0x01000007), arm64: macho(0x0100000c) },
};

test('binaryArch reads the processor from Windows, Linux and Mac executables', () => {
  for (const [, arches] of Object.entries(HEADERS)) {
    for (const [arch, buf] of Object.entries(arches)) assert.equal(P.binaryArch(buf), arch);
  }
  assert.equal(P.binaryArch(pe(0x14c)), ''); // 32-bit x86
  assert.equal(P.binaryArch(elf(0x28)), ''); // 32-bit ARM
  assert.equal(P.binaryArch(macho(7)), ''); // 32-bit x86
  const broken = pe(0x8664);
  broken.writeUInt32LE(0xf0, 0x3c); // the PE header pointer runs past the bytes read
  assert.equal(P.binaryArch(broken), '');
  const notPe = pe(0x8664);
  notPe.write('NE', 0x80, 'latin1');
  assert.equal(P.binaryArch(notPe), '');
  assert.equal(P.binaryArch(Buffer.from('#!/bin/sh\n')), '');
  assert.equal(P.binaryArch(Buffer.alloc(0)), '');
  assert.equal(P.binaryArch(Buffer.from('MZ')), '');
});

/** A fake node_modules/electron with a build for `platform`/`arch`, as Electron's installer leaves it. */
function fakeElectron(platform, arch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wilfred-pkg-'));
  const electronDir = path.join(dir, 'electron');
  const dist = path.join(electronDir, 'dist');
  const exe = P.TARGETS[platform].electron;
  fs.mkdirSync(path.dirname(path.join(dist, exe)), { recursive: true });
  fs.writeFileSync(path.join(dist, exe), HEADERS[platform][arch]);
  const resources = platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'Resources') : path.join(dist, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'default_app.asar'), 'sample app');
  fs.writeFileSync(path.join(dist, 'version'), '44.9.3');
  fs.writeFileSync(path.join(dist, 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(dist, 'LICENSES.chromium.html'), '<html></html>');
  fs.writeFileSync(path.join(electronDir, 'path.txt'), exe);
  return { dir, electronDir, out: path.join(dir, 'dist', `Wilfred-${platform}-${arch}`), resources };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`assemble: Wilfred for ${platform}, unpacked, with Electron's licences and without its sample app`, () => {
    const f = fakeElectron(platform, 'arm64');
    // An earlier build in the way is replaced.
    const earlier = platform === 'darwin' ? path.join(f.out, 'Wilfred.app', 'Contents', 'Resources', 'app') : path.join(f.out, 'resources', 'app');
    fs.mkdirSync(earlier, { recursive: true });
    fs.writeFileSync(path.join(earlier, 'package.json'), '{}');
    fs.writeFileSync(path.join(f.out, 'stale.txt'), 'old');
    const exe = P.assemble({ root: ROOT, electronDir: f.electronDir, platform, arch: 'arm64', out: f.out });
    assert.equal(exe, path.join(f.out, P.TARGETS[platform].wilfred));
    assert.equal(P.binaryArch(fs.readFileSync(exe)), 'arm64');
    assert.equal(fs.existsSync(path.join(f.out, 'stale.txt')), false);
    assert.equal(fs.existsSync(path.join(f.out, P.TARGETS[platform].electron)), false);
    for (const kept of ['LICENSE', 'LICENSES.chromium.html']) assert.ok(fs.existsSync(path.join(f.out, kept)), kept);
    assert.equal(fs.existsSync(path.join(f.out, 'version')), false);
    const resources = platform === 'darwin' ? path.join(f.out, 'Wilfred.app', 'Contents', 'Resources') : path.join(f.out, 'resources');
    assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), false);
    const app = path.join(resources, 'app');
    for (const rel of ['src/main.js', 'src/renderer/index.html', 'assets/wilfred.ico', 'LICENSE', 'README.md', 'SECURITY.md', 'docs/themes.md']) {
      assert.ok(fs.existsSync(path.join(app, rel)), rel);
    }
    assert.equal(fs.existsSync(path.join(app, 'start-wilfred.sh')), platform === 'linux');
    assert.equal(fs.existsSync(path.join(app, 'tools', 'linux-apparmor.sh')), platform === 'linux');
    // Nothing a built app doesn't need: no tests, no other tools, no screenshots, no node_modules.
    for (const left of ['test', 'tools/check-isolation.js', 'docs/board.png', 'node_modules', 'package-lock.json']) {
      assert.equal(fs.existsSync(path.join(app, left)), false, left);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    const mine = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'src/main.js');
    assert.equal(pkg.productName, 'Wilfred');
    assert.equal(pkg.version, mine.version);
    assert.equal(pkg.devDependencies, undefined);
    assert.equal(pkg.scripts, undefined);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });
}

test('assemble refuses another platform\'s or processor\'s build, unknown targets, and building over the app', () => {
  const f = fakeElectron('win32', 'x64');
  const opts = { root: ROOT, electronDir: f.electronDir, platform: 'win32', arch: 'x64', out: f.out };
  assert.throws(() => P.assemble({ ...opts, platform: 'linux' }), /not the linux build: run Electron's install\.js/);
  assert.throws(() => P.assemble({ ...opts, arch: 'arm64' }), /built for "x64", not arm64/);
  assert.throws(() => P.assemble({ ...opts, platform: 'mas' }), /unknown platform "mas"/);
  assert.throws(() => P.assemble({ ...opts, arch: 'ia32' }), /unknown processor "ia32"/);
  assert.throws(() => P.assemble({ ...opts, out: ROOT }), /refusing to build into .*: it holds the app itself/);
  assert.throws(() => P.assemble({ ...opts, out: path.dirname(ROOT) }), /it holds the app itself/);
  assert.throws(() => P.assemble({ ...opts, out: path.join(ROOT, 'src') }), /inside the app, builds go under dist\//);
  assert.throws(() => P.assemble({ ...opts, out: path.join(ROOT, 'new-folder') }), /inside the app, builds go under dist\//);
  assert.throws(() => P.assemble({ ...opts, out: path.join(f.electronDir, 'dist') }), /inside Electron's own folder/);
  // A folder that is there and isn't an earlier build is never deleted.
  const precious = path.join(f.dir, 'Documents');
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, 'mine.txt'), 'keep');
  assert.throws(() => P.assemble({ ...opts, out: precious }), /it exists and is not an earlier build/);
  assert.equal(fs.readFileSync(path.join(precious, 'mine.txt'), 'utf8'), 'keep');
  // A link to the app's parent is seen through.
  const link = path.join(f.dir, 'link');
  fs.symlinkSync(path.dirname(ROOT), link, 'junction');
  assert.throws(() => P.assemble({ ...opts, out: link }), /it holds the app itself/);
  fs.unlinkSync(link);
  fs.symlinkSync(ROOT, link, 'junction');
  assert.throws(() => P.assemble({ ...opts, out: path.join(link, 'src', 'not-yet') }), /inside the app, builds go under dist\//);
  fs.unlinkSync(link);
  assert.throws(() => P.assemble({ ...opts, electronDir: path.join(f.dir, 'nowhere') }), /not the win32 build/);
  fs.writeFileSync(path.join(f.electronDir, 'dist', 'electron.exe'), 'not an exe');
  assert.throws(() => P.assemble(opts), /built for "something else", not x64/);
  // Nothing was built by any of these.
  assert.equal(fs.existsSync(f.out), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});
