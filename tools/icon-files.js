// The two icon containers the operating systems want and Electron cannot write: Windows' .ico (a
// Start Menu shortcut's icon must be one) and the Mac's .icns. Pure functions on Buffers, so the
// tests can check every byte; tools/make-icons.js feeds them the rendered butler.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BITMAPINFOHEADER = 40;

/** The width and height a PNG says it has (its IHDR chunk), or null if `buf` is not a PNG. */
function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * A copy of premultiplied BGRA pixels (what Electron's toBitmap() gives) with straight alpha, which
 * is what an .ico's 32-bit picture holds. Clear pixels stay clear.
 */
function unpremultiply(bgra) {
  const out = Buffer.from(bgra);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 0) continue;
    for (let c = i; c < i + 3; c++) out[c] = Math.min(255, Math.round((out[c] * 255) / a));
  }
  return out;
}

/** One 32-bit DIB entry: the header (height doubled for the mask), the rows bottom-up, then the AND mask. */
function dib(width, height, bgra) {
  if (bgra.length !== width * height * 4) throw new Error(`a ${width}x${height} picture needs ${width * height * 4} bytes, not ${bgra.length} bytes`);
  const maskRow = Math.ceil(width / 32) * 4;
  const xor = width * height * 4;
  const out = Buffer.alloc(BITMAPINFOHEADER + xor + maskRow * height);
  out.writeUInt32LE(BITMAPINFOHEADER, 0);
  out.writeInt32LE(width, 4);
  out.writeInt32LE(height * 2, 8);
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  out.writeUInt32LE(xor + maskRow * height, 20);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y;
    bgra.copy(out, BITMAPINFOHEADER + row * width * 4, y * width * 4, (y + 1) * width * 4);
    const mask = BITMAPINFOHEADER + xor + row * maskRow;
    for (let x = 0; x < width; x++) {
      if (bgra[(y * width + x) * 4 + 3] === 0) out[mask + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/**
 * An .ico from `images`, each { width, height, bgra } (straight alpha, top row first) written as a
 * DIB, or { width, height, png } written as it is (the usual way for 256).
 */
function icoFrom(images) {
  if (!images.length) throw new Error('an .ico needs at least one picture: no images given');
  const datas = images.map(({ width, height, bgra, png }) => {
    if (!(width >= 1 && width <= 256 && height >= 1 && height <= 256)) throw new Error(`an .ico picture can be 1 to 256 pixels a side, not ${width}x${height}`);
    if (png) return png;
    if (bgra) return dib(width, height, bgra);
    throw new Error(`the ${width}x${height} picture has neither bgra nor png`);
  });
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ width, height }, i) => {
    const e = 6 + 16 * i;
    head[e] = width & 0xff; // 256 is written as 0
    head[e + 1] = height & 0xff;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(datas[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += datas[i].length;
  });
  return Buffer.concat([head, ...datas]);
}

/** The entries of an .ico: directory sizes, where each picture is, and the size the picture itself has. */
function readIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO file');
  const count = buf.readUInt16LE(4);
  if (buf.length < 6 + 16 * count) throw new Error('the ICO directory is cut short');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const length = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (offset + length > buf.length) throw new Error(`ICO entry ${i} runs past the end of the file`);
    const data = buf.subarray(offset, offset + length);
    const entry = { width: buf[e] || 256, height: buf[e + 1] || 256, bitCount: buf.readUInt16LE(e + 6), offset, length };
    const png = pngSize(data);
    if (png) {
      entries.push({ ...entry, format: 'png', pixelWidth: png.width, pixelHeight: png.height });
    } else if (length >= BITMAPINFOHEADER && data.readUInt32LE(0) === BITMAPINFOHEADER) {
      entries.push({ ...entry, format: 'dib', pixelWidth: data.readInt32LE(4), pixelHeight: data.readInt32LE(8) / 2 });
    } else {
      throw new Error(`ICO entry ${i} is neither a PNG nor a DIB`);
    }
  }
  return entries;
}

/** An .icns from `entries`, each { type, png }: the 'icns' header and total length, then type, length, PNG per entry. */
function icnsFrom(entries) {
  const parts = entries.map(({ type, png }) => {
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error(`an .icns type is four ASCII characters, not "${type}"`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

/** The entries of an .icns: type, where its data is, and the size its PNG says (null if not a PNG). */
function readIcns(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) throw new Error('not an ICNS file (or its length is wrong)');
  const entries = [];
  for (let off = 8; off < buf.length;) {
    if (off + 8 > buf.length) throw new Error(`ICNS entry at ${off} is cut short`);
    const n = buf.readUInt32BE(off + 4);
    if (n < 8 || off + n > buf.length) throw new Error(`ICNS entry at ${off} is cut short`);
    const size = pngSize(buf.subarray(off + 8, off + n));
    entries.push({ type: buf.toString('latin1', off, off + 4), offset: off + 8, length: n - 8, width: size ? size.width : null, height: size ? size.height : null });
    off += n;
  }
  return entries;
}

module.exports = { pngSize, unpremultiply, icoFrom, readIco, icnsFrom, readIcns };
