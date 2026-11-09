// The .ico and .icns writers and readers, on tiny made-up pictures whose every byte is known.
const test = require('node:test');
const assert = require('node:assert/strict');
const { unpremultiply, icoFrom, icnsFrom, readIco, readIcns, pngSize } = require('../tools/icon-files');

// The start of a PNG: the signature and an IHDR chunk saying w x h (enough for anything that reads sizes).
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// 2 x 2, top row first: opaque, clear, half, opaque.
const BGRA = Buffer.from([1, 2, 3, 255, 4, 5, 6, 0, 7, 8, 9, 128, 10, 11, 12, 255]);

test('un-premultiplying brings colour back to full strength and leaves clear pixels clear', () => {
  const src = Buffer.from([0, 0, 0, 0, 128, 128, 128, 128, 64, 32, 0, 128, 200, 0, 10, 128, 9, 8, 7, 255]);
  const out = unpremultiply(src);
  assert.deepEqual([...out], [0, 0, 0, 0, 255, 255, 255, 128, 128, 64, 0, 128, 255, 0, 20, 128, 9, 8, 7, 255]);
  assert.notEqual(out, src);
  assert.equal(src[4], 128, 'the input is left alone');
});

test('a 2x2 picture is written as a bottom-up DIB with its AND mask', () => {
  const ico = icoFrom([{ width: 2, height: 2, bgra: BGRA }]);
  assert.equal(ico.length, 6 + 16 + 40 + 16 + 8);
  assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
  // Directory entry: 2 x 2, no palette, 1 plane, 32 bits, 64 bytes, at 22.
  assert.deepEqual([...ico.subarray(6, 22)], [2, 2, 0, 0, 1, 0, 32, 0, 64, 0, 0, 0, 22, 0, 0, 0]);
  // BITMAPINFOHEADER: size 40, width 2, height 4 (picture and mask), 1 plane, 32 bits, no compression, 24 bytes.
  assert.deepEqual([...ico.subarray(22, 62)], [
    40, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 24, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  // The bottom row comes first.
  assert.deepEqual([...ico.subarray(62, 78)], [7, 8, 9, 128, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 0]);
  // Mask rows padded to 4 bytes, bottom row first: nothing clear, then the clear pixel at x = 1.
  assert.deepEqual([...ico.subarray(78, 86)], [0, 0, 0, 0, 0x40, 0, 0, 0]);
});

test('mask rows wider than a byte keep their bits in order and their padding', () => {
  // 9 x 1, clear at x = 0 and x = 8: the mask row is 0x80, 0x80, then two bytes of padding.
  const bgra = Buffer.alloc(9 * 4, 255);
  bgra[3] = 0;
  bgra[8 * 4 + 3] = 0;
  const ico = icoFrom([{ width: 9, height: 1, bgra }]);
  assert.deepEqual([...ico.subarray(ico.length - 4)], [0x80, 0x80, 0, 0]);
  assert.equal(ico.readUInt32LE(6 + 8), 40 + 36 + 4);
});

test('a 256 entry is a PNG, and its size is written as 0', () => {
  const png = fakePng(256, 256);
  const ico = icoFrom([{ width: 2, height: 2, bgra: BGRA }, { width: 256, height: 256, png }]);
  assert.deepEqual([...ico.subarray(22, 38)], [0, 0, 0, 0, 1, 0, 32, 0, 33, 0, 0, 0, 6 + 32 + 64, 0, 0, 0]);
  assert.deepEqual(ico.subarray(102), png);
});

test('an ICO reads back as what was written', () => {
  const ico = icoFrom([{ width: 2, height: 2, bgra: BGRA }, { width: 256, height: 256, png: fakePng(256, 256) }]);
  assert.deepEqual(readIco(ico), [
    { width: 2, height: 2, bitCount: 32, offset: 38, length: 64, format: 'dib', pixelWidth: 2, pixelHeight: 2 },
    { width: 256, height: 256, bitCount: 32, offset: 102, length: 33, format: 'png', pixelWidth: 256, pixelHeight: 256 },
  ]);
});

test('bad ICO input is refused', () => {
  assert.throws(() => icoFrom([]), /no images/);
  assert.throws(() => icoFrom([{ width: 0, height: 2, bgra: BGRA }]), /0x2/);
  assert.throws(() => icoFrom([{ width: 2, height: 257, png: fakePng(2, 257) }]), /2x257/);
  assert.throws(() => icoFrom([{ width: 2, height: 2, bgra: Buffer.alloc(3) }]), /3 bytes/);
  assert.throws(() => icoFrom([{ width: 2, height: 2 }]), /neither/);
});

test('a broken ICO does not read', () => {
  const good = icoFrom([{ width: 2, height: 2, bgra: BGRA }]);
  assert.throws(() => readIco(Buffer.alloc(4)), /not an ICO/);
  assert.throws(() => readIco(Buffer.from([1, 0, 1, 0, 1, 0])), /not an ICO/);
  assert.throws(() => readIco(Buffer.from([0, 0, 2, 0, 1, 0])), /not an ICO/);
  assert.throws(() => readIco(good.subarray(0, 10)), /directory is cut short/);
  assert.throws(() => readIco(good.subarray(0, 50)), /entry 0 runs past/);
  const odd = Buffer.from(good);
  odd.writeUInt32LE(12, 22);
  assert.throws(() => readIco(odd), /entry 0 is neither/);
  const tiny = Buffer.from(good);
  tiny.writeUInt32LE(4, 6 + 8);
  assert.throws(() => readIco(tiny), /entry 0 is neither/);
});

test('an ICNS is a header, then type, length and PNG per entry, and reads back', () => {
  const a = fakePng(16, 16);
  const b = Buffer.from('not a png');
  const icns = icnsFrom([{ type: 'icp4', png: a }, { type: 'ic09', png: b }]);
  assert.equal(icns.toString('latin1', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), 8 + 8 + 33 + 8 + 9);
  assert.equal(icns.length, icns.readUInt32BE(4));
  assert.equal(icns.toString('latin1', 8, 12), 'icp4');
  assert.equal(icns.readUInt32BE(12), 41);
  assert.deepEqual(icns.subarray(16, 49), a);
  assert.equal(icns.toString('latin1', 49, 53), 'ic09');
  assert.equal(icns.readUInt32BE(53), 17);
  assert.deepEqual(readIcns(icns), [
    { type: 'icp4', offset: 16, length: 33, width: 16, height: 16 },
    { type: 'ic09', offset: 57, length: 9, width: null, height: null },
  ]);
});

test('bad ICNS input is refused, and a broken one does not read', () => {
  assert.throws(() => icnsFrom([{ type: 'ic1', png: fakePng(1, 1) }]), /"ic1"/);
  const good = icnsFrom([{ type: 'icp4', png: fakePng(16, 16) }]);
  assert.throws(() => readIcns(Buffer.from('icn')), /not an ICNS/);
  assert.throws(() => readIcns(Buffer.from('ICNS\0\0\0\x08')), /not an ICNS/);
  assert.throws(() => readIcns(good.subarray(0, 20)), /not an ICNS/);
  const short = Buffer.from(good);
  short.writeUInt32BE(4, 12);
  assert.throws(() => readIcns(short), /entry at 8 is cut short/);
  const long = Buffer.from(good);
  long.writeUInt32BE(99, 12);
  assert.throws(() => readIcns(long), /entry at 8 is cut short/);
  const tail = Buffer.concat([good, Buffer.from('abcd')]);
  tail.writeUInt32BE(tail.length, 4);
  assert.throws(() => readIcns(tail), /entry at 49 is cut short/);
});

test('a PNG size is read from its IHDR, and anything else has none', () => {
  assert.deepEqual(pngSize(fakePng(48, 24)), { width: 48, height: 24 });
  assert.equal(pngSize(Buffer.alloc(10)), null);
  assert.equal(pngSize(Buffer.alloc(30)), null);
  const noIhdr = fakePng(1, 1);
  noIhdr.write('IDAT', 12, 'latin1');
  assert.equal(pngSize(noIhdr), null);
});
