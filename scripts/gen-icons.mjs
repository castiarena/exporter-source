/**
 * Draws the toolbar/store icons and writes them as PNGs.
 *
 * Written from scratch rather than pulled from an image library because
 * 01-requirements.md §4 asks for dependency hygiene, and a four-icon build step
 * is not worth a native canvas dependency. The rasterizer supersamples 4x and
 * box-filters down, which is what gives the curves clean edges at 16px.
 *
 * Run with `npm run icons`. The output is committed, so a normal build does not
 * depend on this script.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'src/icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

/* ---------------------------------------------------------------- */
/* PNG encoding                                                       */
/* ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA8 pixels as a PNG. Filter type 0 on every row; zlib does the rest. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- */
/* Drawing                                                            */
/* ---------------------------------------------------------------- */

class Surface {
  constructor(size) {
    this.size = size;
    this.data = new Float64Array(size * size * 4);
  }

  /** Source-over composite of one premultiplied-free RGBA sample. */
  blend(x, y, [r, g, b, a]) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const dst = this.data;
    const inv = 1 - a;
    dst[i] = r * a + dst[i] * inv;
    dst[i + 1] = g * a + dst[i + 1] * inv;
    dst[i + 2] = b * a + dst[i + 2] * inv;
    dst[i + 3] = a + dst[i + 3] * inv;
  }

  fill(shape, colorAt) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (shape(x + 0.5, y + 0.5)) this.blend(x, y, colorAt(x, y));
      }
    }
  }

  /** Box-filters the supersampled surface down to `target` and returns RGBA8. */
  downsample(target) {
    const factor = this.size / target;
    const out = Buffer.alloc(target * target * 4);
    for (let y = 0; y < target; y += 1) {
      for (let x = 0; x < target; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < factor; sy += 1) {
          for (let sx = 0; sx < factor; sx += 1) {
            const i = ((y * factor + sy) * this.size + (x * factor + sx)) * 4;
            r += this.data[i];
            g += this.data[i + 1];
            b += this.data[i + 2];
            a += this.data[i + 3];
          }
        }
        const n = factor * factor;
        const o = (y * target + x) * 4;
        out[o] = Math.round((r / n) * 255);
        out[o + 1] = Math.round((g / n) * 255);
        out[o + 2] = Math.round((b / n) * 255);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
    return out;
  }
}

const roundedRect = (x0, y0, x1, y1, radius) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

/**
 * The page shape: a rounded rect whose top-right corner is cut by the diagonal
 * running from (x1 - fold, y0) to (x1, y0 + fold).
 */
const pageWithFoldedCorner = (x0, y0, x1, y1, radius, fold) => {
  const base = roundedRect(x0, y0, x1, y1, radius);
  return (x, y) => base(x, y) && x - (x1 - fold) <= y - y0;
};

const triangle = (ax, ay, bx, by, cx, cy) => (x, y) => {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, cx, cy);
  const d3 = sign(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

const mix = (a, b, ratio) => a.map((value, i) => value + (b[i] - value) * ratio);

/**
 * The mark: a blue rounded-square tile, a white page with a folded corner, and
 * a down arrow through it — "this page, coming out as a file".
 */
function draw(size) {
  const s = size * SUPERSAMPLE;
  const surface = new Surface(s);
  const u = s / 128; // design grid is 128 units

  const top = hexToRgb('#4b86f5');
  const bottom = hexToRgb('#2f6fed');
  const white = [1, 1, 1];

  surface.fill(roundedRect(4 * u, 4 * u, 124 * u, 124 * u, 28 * u), (_x, y) => [
    ...mix(top, bottom, y / s),
    1,
  ]);

  // The page: white, centred, with its top-right corner folded away.
  surface.fill(
    pageWithFoldedCorner(30 * u, 22 * u, 98 * u, 106 * u, 6 * u, 22 * u),
    () => [...white, 0.97],
  );

  // Two text lines at the top of the page. Skipped at 16px, where they collapse
  // into a grey smudge instead of reading as text.
  if (size >= 32) {
    for (const [x0, y, x1] of [
      [40, 38, 70],
      [40, 50, 88],
    ]) {
      surface.fill(roundedRect(x0 * u, y * u, x1 * u, (y + 6) * u, 3 * u), () => [
        ...bottom,
        0.4,
      ]);
    }
  }

  // Download arrow through the lower half of the page.
  const cx = 64 * u;
  surface.fill(roundedRect(cx - 7 * u, 62 * u, cx + 7 * u, 82 * u, 3 * u), () => [...bottom, 1]);
  surface.fill(
    triangle(cx - 22 * u, 78 * u, cx + 22 * u, 78 * u, cx, 100 * u),
    () => [...bottom, 1],
  );

  return surface.downsample(size);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, draw(size));
  writeFileSync(resolve(outDir, `icon-${size}.png`), png);
  console.log(`wrote src/icons/icon-${size}.png (${png.length} bytes)`);
}
