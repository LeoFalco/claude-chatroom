#!/usr/bin/env node
// Renders the PWA icons (PNG) from the logo shapes, with no image dependencies.
// The shapes mirror web/favicon.svg (64x64 viewBox); keep the two in sync.
//   node scripts/build-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

const DARK = [0x1c, 0x1b, 0x19, 255];
const ORANGE = [0xc2, 0x41, 0x0c, 255];
const PEACH = [0xf4, 0xa2, 0x61, 255];
const WHITE = [255, 255, 255, 255];

const roundRect = (x, y, w, h, r) => (px, py) => {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return px >= x && px <= x + w && py >= y && py <= y + h && (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const triangle = (ax, ay, bx, by, cx, cy) => (px, py) => {
  const s = (x1, y1, x2, y2) => (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d1 = s(ax, ay, bx, by), d2 = s(bx, by, cx, cy), d3 = s(cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;

// Painted in order, like the SVG.
const LOGO = [
  [roundRect(4, 8, 40, 30, 8), ORANGE],
  [triangle(14, 38, 12, 48, 24, 38), ORANGE],
  [roundRect(22, 22, 38, 28, 8), PEACH],
  [triangle(50, 50, 52, 59, 42, 50), PEACH],
  [circle(33, 36, 2.6), WHITE],
  [circle(41, 36, 2.6), WHITE],
  [circle(49, 36, 2.6), WHITE],
];

/**
 * @param size output pixels
 * @param maskable full-bleed dark background with the logo inside the 80% safe zone
 */
function render(size, { maskable = false } = {}) {
  const SS = 4; // supersampling per axis
  const rgba = Buffer.alloc(size * size * 4);
  const scale = maskable ? 0.6 : 1;
  const offset = maskable ? 12.8 : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Sample point in the 64x64 logo space.
          const lx = (((x + (sx + 0.5) / SS) / size) * 64 - offset) / scale;
          const ly = (((y + (sy + 0.5) / SS) / size) * 64 - offset) / scale;
          let color = maskable ? DARK : null;
          for (const [inside, c] of LOGO) if (inside(lx, ly)) color = c;
          if (color) for (let i = 0; i < 4; i++) acc[i] += color[i] * (i < 3 ? color[3] / 255 : 1);
        }
      }
      const n = SS * SS;
      const alpha = acc[3] / n;
      const o = (y * size + x) * 4;
      // Un-premultiply.
      for (let i = 0; i < 3; i++) rgba[o + i] = alpha ? Math.round(acc[i] / n / (alpha / 255)) : 0;
      rgba[o + 3] = Math.round(alpha);
    }
  }
  return png(size, size, rgba);
}

// ---- minimal PNG encoder (RGBA, 8-bit) ----------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(out, { recursive: true });
const icons = {
  'icon-192.png': render(192),
  'icon-512.png': render(512),
  'maskable-192.png': render(192, { maskable: true }),
  'maskable-512.png': render(512, { maskable: true }),
  'apple-touch-icon.png': render(180, { maskable: true }),
};
for (const [name, data] of Object.entries(icons)) writeFileSync(join(out, name), data);
console.log(`Wrote ${Object.keys(icons).length} icons to ${out}`);
