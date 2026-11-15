/* PWAアイコン生成スクリプト(依存ゼロ: zlibでPNGを直接エンコード)
 * 生成: icons/icon-192.png / icon-512.png / apple-touch-icon.png
 * 実行: node scripts/gen-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------- 最小PNGエンコーダ ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 描画ヘルパ ---------- */
const smooth = (d, aa) => Math.max(0, Math.min(1, 0.5 - d / aa)); // SDF→coverage(中心0,外側負)

function inCircle(px, py, cx, cy, r) { return Math.hypot(px - cx, py - cy) - r; }
function inRect(px, py, x0, y0, x1, y1) {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}
function inTri(px, py, ax, ay, bx, by, cx2, cy2) {
  const s = (ax - cx2) * (py - cy2) - (ay - cy2) * (px - cx2);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const u = (cx2 - bx) * (py - by) - (cy2 - by) * (px - bx);
  const inside = (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
  if (inside) {
    // 辺までの最短距離(大まかに)
    const d = (f) => Math.abs(f) / Math.hypot(1, 1);
    return -Math.min(d(s), d(t), d(u)) * 0.7;
  }
  return 1; // 外
}

/* ---------- アイコン生成 ---------- */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1.5 / size * size; // アンチエイリアス幅(1.5px相当)
  const A = 1.5 / size * 100; // dummy
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size, ny = y / size; // 0..1
      const i = (y * size + x) * 4;

      // 背景: 濃いブラウン+中心の暖かいグラデーション
      const g = Math.max(0, 1 - Math.hypot(nx - 0.5, ny - 0.42) / 0.75);
      let r = 20 + g * 26, gg = 16 + g * 22, b = 14 + g * 16;

      // 角丸マスク
      const corner = 0.18 * size;
      const bgShape = Math.min(
        inRect(nx, ny, -1, -1, size, size), // dummy
        0
      );
      const rad = size * 0.22;
      const dx = Math.min(nx * size, size - nx * size);
      const dy = Math.min(ny * size, size - ny * size);
      let bgA = 1;
      if (dx < rad && dy < rad) {
        const d = rad - Math.hypot(dx - rad, dy - rad);
        bgA = Math.max(0, Math.min(1, d / aa));
      }

      // 音符(アンバー) — ノート頭+棹+旗
      const head = inCircle(nx * size, ny * size, 0.42 * size, 0.66 * size, 0.115 * size);
      const stem = inRect(nx * size, ny * size, 0.505 * size, 0.28 * size, 0.545 * size, 0.66 * size);
      const flag = inTri(nx * size, ny * size, 0.545 * size, 0.28 * size, 0.70 * size, 0.40 * size, 0.545 * size, 0.50 * size);
      const noteD = Math.min(head, stem, flag);
      const noteA = smooth(noteD, aa);

      // スチーム風の丸(アクセント)は省略 — シンプルな1音符
      const cr = 217 + (238 - 217) * (1 - ny), cg = 160 + (195 - 160) * (1 - ny), cb = 107 + (154 - 107) * (1 - ny);

      r = r + (cr - r) * noteA;
      gg = gg + (cg - gg) * noteA;
      b = b + (cb - b) * noteA;

      px[i] = Math.round(r);
      px[i + 1] = Math.round(gg);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(bgA * 255);
    }
  }
  return encodePNG(size, size, px);
}

const outDir = path.join(__dirname, '..', 'remote', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(outDir, name), drawIcon(size));
  console.log('wrote', name, size + 'x' + size);
}
