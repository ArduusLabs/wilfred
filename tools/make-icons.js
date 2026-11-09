// Renders Wilfred's butler (from the page's own SVG) to the PNG icons the tray, window and Dock use,
// the Mac's black menu bar template from the bow-tie glyph, and the small marks the menu shows.
// It also packs the butler into assets/wilfred.ico (a Start Menu shortcut's icon, which names the
// Windows notices) and assets/wilfred.icns (for a Mac bundle).
// Run with: npx electron tools/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { unpremultiply, icoFrom, readIco, icnsFrom, readIcns } = require('./icon-files');

const RENDER = 256;
// The Dock and the About panel want a big picture: the butler is drawn at this size for it, not scaled up.
const BIG = 512;
const SIZES = [16, 20, 24, 32, 48, 64, 256];
// One file per Windows scale factor; Electron picks the @Nx file that matches the screen.
const SCALES = [['', 16], ['@1.25x', 20], ['@1.5x', 24], ['@2x', 32]];
// The Mac menu bar: 16 pt, and the same at 2x for Retina. The name must end in "Template".
const TEMPLATE_SCALES = [['', 16], ['@2x', 32]];
// The .ico: small sizes as 32-bit pictures (what every Windows reads), 256 as a PNG.
const ICO_DIB = [16, 24, 32, 48, 64];
const ICO_PNG = 256;
// The .icns: Apple's type for each PNG and its size in pixels (ic11 to ic14 are the @2x ones).
const ICNS = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic11', 32], ['ic12', 64], ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512]];
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const avatar = html.match(/<svg id="avatar-svg"[\s\S]*?<\/svg>/)[0];
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

// The bow tie from the page's --glyph-bowtie, black on transparent: about 14 x 9 within 16 x 16.
const bowtieData = css.match(/--glyph-bowtie:\s*url\("data:image\/svg\+xml,([^"]+)"\)/)[1];
const bowtie = decodeURIComponent(bowtieData)
  .replace(/^<svg /, '<svg width="14" height="9.06" preserveAspectRatio="xMidYMid meet" fill="#000" ');
const TRAY_TEMPLATE = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><svg x="1" y="3.47" ${bowtie.slice('<svg '.length)}</svg>`;

// The menu's privacy marks: a green check while the network lock holds, a red cross if it ever didn't.
const MARKS = {
  'menu-check': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7.5" fill="#2fbf71"/><path d="M4.6 8.4l2.3 2.3 4.5-4.9" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'menu-cross': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7.5" fill="#e5484d"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/></svg>',
};

/** Renders `svg` (styled by `style`) on a transparent size×size page in `win` and returns the capture. */
async function render(win, name, svg, style, size = RENDER) {
  win.setContentSize(size, size);
  // The page's own stylesheet sizes the avatar for the board; the icon needs the whole page.
  const page = `<!doctype html><style>${style} html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
    body>svg{width:${size}px!important;height:${size}px!important;display:block}</style>${svg}`;
  const tmp = path.join(os.tmpdir(), `wilfred-icon-${name}.html`);
  fs.writeFileSync(tmp, page);
  try {
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 500));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    if (img.isEmpty()) throw new Error(`${name} rendered nothing`);
    if (img.getSize().width < size) throw new Error(`${name} rendered at ${img.getSize().width} px, not ${size}`);
    return img;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The width and height a PNG file says it has (its IHDR chunk). */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`${path.basename(file)} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * Packs the butler into the .ico and .icns, reads both back (every entry there, every size right)
 * and only then writes them, so a bad pack leaves the old files as they were.
 */
function writeContainers(butler, big, outDir) {
  const at = (size) => (size === BIG ? big : butler).resize({ width: size, height: size, quality: 'best' });
  // toBitmap() is premultiplied BGRA; an .ico's 32-bit picture wants straight alpha.
  const ico = icoFrom([
    ...ICO_DIB.map((size) => ({ width: size, height: size, bgra: unpremultiply(at(size).toBitmap()) })),
    { width: ICO_PNG, height: ICO_PNG, png: at(ICO_PNG).toPNG() },
  ]);
  const icns = icnsFrom(ICNS.map(([type, size]) => ({ type, png: at(size).toPNG() })));
  const icoWant = [...ICO_DIB.map((size) => ['dib', size]), ['png', ICO_PNG]];
  const checkIco = (buf) => {
    const got = readIco(buf);
    if (got.length !== icoWant.length) throw new Error(`wilfred.ico holds ${got.length} pictures, not ${icoWant.length}`);
    icoWant.forEach(([format, size], i) => {
      const e = got[i];
      if (e.format !== format || e.width !== size || e.height !== size || e.pixelWidth !== size || e.pixelHeight !== size) {
        throw new Error(`wilfred.ico picture ${i} is a ${e.pixelWidth}x${e.pixelHeight} ${e.format}, not a ${size}x${size} ${format}`);
      }
    });
  };
  const checkIcns = (buf) => {
    const got = readIcns(buf);
    if (got.length !== ICNS.length) throw new Error(`wilfred.icns holds ${got.length} pictures, not ${ICNS.length}`);
    ICNS.forEach(([type, size], i) => {
      const e = got[i];
      if (e.type !== type || e.width !== size || e.height !== size) throw new Error(`wilfred.icns entry ${i} is ${e.type} ${e.width}x${e.height}, not ${type} ${size}x${size}`);
    });
  };
  checkIco(ico);
  checkIcns(icns);
  const files = [['wilfred.ico', ico, checkIco], ['wilfred.icns', icns, checkIcns]];
  for (const [name, buf] of files) {
    const file = path.join(outDir, name);
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
  }
  // Read back what was written, from the disk.
  for (const [name, , check] of files) check(fs.readFileSync(path.join(outDir, name)));
  return files.length;
}

/** Throws unless every visible pixel of `img` is black (a template image may carry no colour). */
function assertBlack(img, name) {
  const px = img.toBitmap();
  let visible = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    visible++;
    if (px[i] || px[i + 1] || px[i + 2]) throw new Error(`${name} has a coloured pixel at ${i / 4}`);
  }
  if (!visible) throw new Error(`${name} is empty`);
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (img, name, size, check) => {
    const out = img.resize({ width: size, height: size, quality: 'best' });
    if (check) check(out, name);
    const file = path.join(outDir, name);
    fs.writeFileSync(file, out.toPNG());
    written.push([file, size]);
  };
  // One window for every page: a second offscreen window would not load a file here.
  const win = new BrowserWindow({ width: RENDER, height: RENDER, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  try {
    const still = `${css} .figure,.pupils{animation:none!important}`;
    const butler = await render(win, 'butler', avatar, still);
    for (const size of SIZES) write(butler, `wilfred-${size}.png`, size);
    for (const [suffix, size] of SCALES) write(butler, `tray${suffix}.png`, size);
    const big = await render(win, 'butler-big', avatar, still, BIG);
    write(big, `wilfred-${BIG}.png`, BIG);
    const template = await render(win, 'tray-template', TRAY_TEMPLATE, '');
    for (const [suffix, size] of TEMPLATE_SCALES) write(template, `trayTemplate${suffix}.png`, size, assertBlack);
    for (const [name, svg] of Object.entries(MARKS)) {
      const mark = await render(win, name, svg, '');
      for (const [suffix, size] of SCALES) write(mark, `${name}${suffix}.png`, size);
    }
    // Read back what was written: every file a PNG of the size it should be.
    for (const [file, size] of written) {
      const got = pngSize(file);
      if (got.width !== size || got.height !== size) throw new Error(`${path.basename(file)} is ${got.width}x${got.height}, not ${size}x${size}`);
    }
    const containers = writeContainers(butler, big, outDir);
    console.log(`${written.length} icons and ${containers} icon files written to`, outDir);
  } catch (e) {
    console.error('icons NOT written:', e.message);
    process.exitCode = 1;
  }
  app.quit();
});
