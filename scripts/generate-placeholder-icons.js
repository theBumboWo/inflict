#!/usr/bin/env node
/**
 * generate-placeholder-icons.js
 *
 * Generates placeholder PNG and ICO files for KeyWallet branding.
 * Produces a simple dark-blue icon with "KW" initials.
 *
 * Usage: node scripts/generate-placeholder-icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (no external deps)
// ---------------------------------------------------------------------------

/**
 * Write a 4-byte big-endian unsigned integer into a Buffer at offset.
 */
function writeUInt32BE(buf, value, offset) {
  buf[offset]     = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>>  8) & 0xff;
  buf[offset + 3] =  value         & 0xff;
}

/**
 * Compute CRC-32 for PNG chunk validation.
 */
function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c;
    }
    return t;
  })();

  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a single PNG chunk (length + type + data + CRC).
 */
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const dataBytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunk     = Buffer.alloc(4 + 4 + dataBytes.length + 4);
  writeUInt32BE(chunk, dataBytes.length, 0);
  typeBytes.copy(chunk, 4);
  dataBytes.copy(chunk, 8);
  const crcData = Buffer.alloc(4 + dataBytes.length);
  typeBytes.copy(crcData, 0);
  dataBytes.copy(crcData, 4);
  writeUInt32BE(chunk, crc32(crcData), 8 + dataBytes.length);
  return chunk;
}

/**
 * Encode an RGBA pixel array (width × height × 4 bytes) as a PNG buffer.
 */
function encodePNG(width, height, pixels) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width(4) height(4) bitDepth(1) colorType(2=RGB, 6=RGBA) compression(0) filter(0) interlace(0)
  const ihdrData = Buffer.alloc(13);
  writeUInt32BE(ihdrData, width,  0);
  writeUInt32BE(ihdrData, height, 4);
  ihdrData[8]  = 8;   // bit depth
  ihdrData[9]  = 6;   // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = pngChunk('IHDR', ihdrData);

  // Raw (unfiltered) scanlines: prepend filter byte 0 to each row
  const rawSize  = height * (1 + width * 4);
  const raw      = Buffer.alloc(rawSize);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const pixelIdx = (y * width + x) * 4;
      const rawIdx   = rowStart + 1 + x * 4;
      raw[rawIdx]     = pixels[pixelIdx];      // R
      raw[rawIdx + 1] = pixels[pixelIdx + 1];  // G
      raw[rawIdx + 2] = pixels[pixelIdx + 2];  // B
      raw[rawIdx + 3] = pixels[pixelIdx + 3];  // A
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// Draw helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Rasterise a pixel array for a square image with:
 *   - dark-blue (#1a237e) background
 *   - lighter rounded rectangle badge
 *   - white "KW" text approximation (block pixels)
 */
function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  // Background colour: deep navy #1a237e
  const BG = [26, 35, 126, 255];
  // Badge colour: medium blue #3949ab
  const BADGE = [57, 73, 171, 255];
  // Text colour: white
  const TEXT = [255, 255, 255, 255];

  const setPixel = (x, y, rgba) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i]     = rgba[0];
    pixels[i + 1] = rgba[1];
    pixels[i + 2] = rgba[2];
    pixels[i + 3] = rgba[3];
  };

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels.set(BG, i * 4);
  }

  // Draw rounded rectangle badge (80% of size, centred)
  const margin    = Math.floor(size * 0.1);
  const badgeSize = size - margin * 2;
  const radius    = Math.floor(badgeSize * 0.18);

  for (let y = margin; y < margin + badgeSize; y++) {
    for (let x = margin; x < margin + badgeSize; x++) {
      const lx = x - margin;
      const ly = y - margin;
      // Check if inside rounded-rect
      const inCorner =
        (lx < radius           && ly < radius           && Math.hypot(lx - radius,            ly - radius)            > radius) ||
        (lx > badgeSize - 1 - radius && ly < radius           && Math.hypot(lx - (badgeSize - 1 - radius), ly - radius)            > radius) ||
        (lx < radius           && ly > badgeSize - 1 - radius && Math.hypot(lx - radius,            ly - (badgeSize - 1 - radius)) > radius) ||
        (lx > badgeSize - 1 - radius && ly > badgeSize - 1 - radius && Math.hypot(lx - (badgeSize - 1 - radius), ly - (badgeSize - 1 - radius)) > radius);
      if (!inCorner) {
        setPixel(x, y, BADGE);
      }
    }
  }

  // Draw "KW" glyph using thick scaled pixels
  // We define a 7×5 dot-matrix for "K" and "W" and scale to fit
  const KW_DOTS = [
    // K  (7 rows × 5 cols, 1=on 0=off)
    [1,0,0,0,1],
    [1,0,0,1,0],
    [1,0,1,0,0],
    [1,1,0,0,0],
    [1,0,1,0,0],
    [1,0,0,1,0],
    [1,0,0,0,1],
  ];
  const W_DOTS = [
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,1,0,1],
    [1,0,1,0,1],
    [1,1,0,1,1],
    [0,1,0,1,0],
    [0,0,1,0,0],
  ];

  const glyphH    = 7;
  const glyphW    = 5;
  const glyphGap  = 1;                          // gap columns between K and W
  const totalCols = glyphW * 2 + glyphGap;

  // The text region takes ~60% of badge width and 50% of badge height
  const textRegW = Math.floor(badgeSize * 0.60);
  const textRegH = Math.floor(badgeSize * 0.50);
  const dotW     = Math.max(1, Math.floor(textRegW / totalCols));
  const dotH     = Math.max(1, Math.floor(textRegH / glyphH));

  const textLeft = margin + Math.floor((badgeSize - dotW * totalCols) / 2);
  const textTop  = margin + Math.floor((badgeSize - dotH * glyphH)    / 2);

  for (let row = 0; row < glyphH; row++) {
    for (let col = 0; col < glyphW; col++) {
      // K
      if (KW_DOTS[row][col]) {
        for (let dy = 0; dy < dotH; dy++) {
          for (let dx = 0; dx < dotW; dx++) {
            setPixel(textLeft + col * dotW + dx, textTop + row * dotH + dy, TEXT);
          }
        }
      }
      // W (offset by glyphW + gap)
      if (W_DOTS[row][col]) {
        for (let dy = 0; dy < dotH; dy++) {
          for (let dx = 0; dx < dotW; dx++) {
            setPixel(textLeft + (glyphW + glyphGap + col) * dotW + dx, textTop + row * dotH + dy, TEXT);
          }
        }
      }
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// ICO encoder
// ---------------------------------------------------------------------------
// An ICO file can embed a PNG directly (PNG-in-ICO) for sizes >= 32×32.
// We embed a 256×256 PNG inside an ICO container (Vista+ format).

function encodePNGInICO(pngBuffer) {
  const count = 1;
  // ICO header: reserved(2) + type(2=ICO) + count(2)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0,     0); // reserved
  header.writeUInt16LE(1,     2); // type: ICO
  header.writeUInt16LE(count, 4);

  // Directory entry (16 bytes per image)
  const dir = Buffer.alloc(16);
  dir[0] = 0;   // width  0 means 256
  dir[1] = 0;   // height 0 means 256
  dir[2] = 0;   // color count (0 = more than 256)
  dir[3] = 0;   // reserved
  dir.writeUInt16LE(1, 4);  // color planes
  dir.writeUInt16LE(32, 6); // bits per pixel
  dir.writeUInt32LE(pngBuffer.length, 8);  // size of image data
  dir.writeUInt32LE(6 + 16, 12);           // offset of image data

  return Buffer.concat([header, dir, pngBuffer]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    console.log('Created assets/ directory');
  }

  // 1. Generate 512×512 PNG for macOS/Linux
  console.log('Generating 512×512 PNG...');
  const pixels512 = drawIcon(512);
  const png512    = encodePNG(512, 512, pixels512);
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), png512);
  console.log(`  assets/icon.png written (${png512.length} bytes)`);

  // 2. Generate 256×256 PNG to embed inside ICO for Windows
  console.log('Generating 256×256 ICO (PNG-in-ICO)...');
  const pixels256 = drawIcon(256);
  const png256    = encodePNG(256, 256, pixels256);
  const ico       = encodePNGInICO(png256);
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), ico);
  console.log(`  assets/icon.ico written (${ico.length} bytes)`);

  console.log('Done. Placeholder icons generated in assets/');
}

main();
