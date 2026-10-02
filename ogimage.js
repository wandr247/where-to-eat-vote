// Tiny dependency-free PNG compositor for the per-room Open Graph card (uses only Node's built-in zlib).
// Assets are pre-rendered by tools/build-og.js: a 1200x630 background and an atlas of the digits 0-9.
const fs = require('fs'), zlib = require('zlib'), path = require('path');

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// decode an 8-bit, non-interlaced RGB/RGBA PNG into { w, h, data: RGBA Buffer }
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9];
      if (body[8] !== 8 || body[12] !== 0 || (ct !== 6 && ct !== 2)) throw new Error('unsupported PNG format');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

function encodePng(w, h, rgb) {   // rgb: w*h*3 buffer
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, body) => {
    const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
    return Buffer.concat([len, t, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const TILE_W = 130, TILE_H = 190, TILE_GAP = 14, ROW_Y = 215, ROW_X = 595;   // must match tools/build-og.js layout
let bg = null, atlas = null;
const cache = new Map();
function load(dir) {
  bg = decodePng(fs.readFileSync(path.join(dir, 'og-room-bg.png')));
  atlas = decodePng(fs.readFileSync(path.join(dir, 'og-digits.png')));
}

// returns a PNG Buffer for a 4-digit room code
function roomImage(dir, code) {
  if (!/^\d{4}$/.test(code)) throw new Error('bad code');
  if (cache.has(code)) return cache.get(code);
  if (!bg) load(dir);
  const out = Buffer.alloc(bg.w * bg.h * 3);
  for (let i = 0, n = bg.w * bg.h; i < n; i++) { out[i * 3] = bg.data[i * 4]; out[i * 3 + 1] = bg.data[i * 4 + 1]; out[i * 3 + 2] = bg.data[i * 4 + 2]; }
  for (let k = 0; k < 4; k++) {
    const d = code.charCodeAt(k) - 48, ox = ROW_X + k * (TILE_W + TILE_GAP);
    for (let y = 0; y < TILE_H; y++) for (let x = 0; x < TILE_W; x++) {
      const s = (y * atlas.w + d * TILE_W + x) * 4, a = atlas.data[s + 3];
      if (!a) continue;
      const o = ((ROW_Y + y) * bg.w + ox + x) * 3, ia = 255 - a;
      for (let c = 0; c < 3; c++) out[o + c] = (atlas.data[s + c] * a + out[o + c] * ia + 127) / 255 | 0;
    }
  }
  const png = encodePng(bg.w, bg.h, out);
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(code, png);
  return png;
}
module.exports = { roomImage, decodePng, encodePng };
