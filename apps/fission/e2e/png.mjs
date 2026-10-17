// PNG reading and writing for the screenshot checks (testing catch-up TC3),
// with no packages: Node's zlib inflates, and the five row filters are
// undone here. Reads the 8-bit, non-interlaced RGB and RGBA files browsers
// write for screenshots; refuses anything else by name. `compareImages`
// counts the pixels that differ by more than a channel threshold and
// draws them in red for a diff image. Tested in png.test.mjs.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes a PNG to { width, height, data } with data as RGBA bytes, row by row. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`only 8-bit non-interlaced RGB or RGBA PNGs, not depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error(`PNG data is ${raw.length} bytes, expected ${height * (stride + 1)}`);
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y * stride + x - channels] : 0; // left
      const b = y > 0 ? rows[(y - 1) * stride + x] : 0; // up
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0; // up-left
      let add;
      if (filter === 0) add = 0;
      else if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`unknown PNG row filter ${filter}`);
      rows[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[4 * i] = rows[3 * i];
    data[4 * i + 1] = rows[3 * i + 1];
    data[4 * i + 2] = rows[3 * i + 2];
    data[4 * i + 3] = 255;
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encodes RGBA bytes as a PNG (no row filters), for baselines and diff images. */
export function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (4 * width + 1));
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * 4 * width, 4 * width).copy(raw, y * (4 * width + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Compares two images pixel by pixel: a pixel differs when any channel
 * differs by more than `channel`. Returns how many differ, whether that is
 * within `maxPixels`, and a diff image (the expected image dimmed, differing
 * pixels red). Images of different sizes differ everywhere.
 */
export function compareImages(expected, actual, { channel, maxPixels }) {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { differing: Math.max(expected.width * expected.height, actual.width * actual.height), ok: false, sizes: `${expected.width}×${expected.height} vs ${actual.width}×${actual.height}`, diff: null };
  }
  const diff = Buffer.alloc(expected.data.length);
  let differing = 0;
  for (let i = 0; i < expected.data.length; i += 4) {
    let worst = 0;
    for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(expected.data[i + k] - actual.data[i + k]));
    if (worst > channel) {
      differing++;
      diff.set([255, 0, 0, 255], i);
    } else diff.set([expected.data[i] >> 2, expected.data[i + 1] >> 2, expected.data[i + 2] >> 2, 255], i);
  }
  return { differing, ok: differing <= maxPixels, diff: { width: expected.width, height: expected.height, data: diff } };
}
