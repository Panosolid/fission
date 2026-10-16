import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSUMED_DPI, crc32, dpiToMmPerPixel, mmPerPixelToDpi, readPhysicalSize } from "../src/physical-size.ts";
import { chunk, idat, iend, ihdr, jfif, jpeg, phys, png, refusal, segment, sof, sos } from "./helpers.ts";

const close = (a: number, b: number, rel = 1e-12) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} ≈ ${b}`);

test("DPI and mm per pixel, worked by hand", () => {
  // An inch is 25.4 mm, so at 300 dots per inch one dot is 25.4 / 300 = 0.08466… mm.
  close(dpiToMmPerPixel(300), 0.0846666666666667);
  // At 254 DPI: 25.4 / 254 = 0.1 mm exactly (ten pixels per mm).
  close(dpiToMmPerPixel(254), 0.1);
  // The other way: 0.5 mm per pixel is 25.4 / 0.5 = 50.8 DPI.
  close(mmPerPixelToDpi(0.5), 50.8);
});

test("CRC-32 matches the PNG spec's own value", () => {
  // Every PNG ends with the chunk IEND (no data), whose CRC is printed in
  // the PNG spec's examples and in every PNG file: AE 42 60 82.
  assert.equal(crc32(new TextEncoder().encode("IEND")), 0xae426082);
  // And the standard check value of CRC-32 over the ASCII "123456789" is CBF43926.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("a PNG's pHYs gives its size", () => {
  // 10000 pixels per metre = 10 per mm, so a pixel is 0.1 mm and 200 × 100 pixels are 20 × 10 mm.
  const size = readPhysicalSize(png(ihdr(200, 100), phys(10000, 10000, 1), idat(), iend()));
  assert.deepEqual(size, { format: "png", width: 200, height: 100, mmPerPixel: 0.1, source: "file", note: null });
  // 300 DPI is stored rounded, as round(300 / 0.0254) = 11811 per metre, so 1000 / 11811 = 0.0846668… mm (a hair over 25.4 / 300 = 0.0846667).
  close(readPhysicalSize(png(ihdr(1, 1), phys(11811, 11811, 1), idat(), iend())).mmPerPixel, 0.08466683600033867);
});

test("a PNG with no usable density is assumed to be 96 DPI and says why", () => {
  const assumed = (bytes: Uint8Array) => {
    const s = readPhysicalSize(bytes);
    assert.equal(s.source, "assumed");
    close(s.mmPerPixel, 25.4 / ASSUMED_DPI); // 0.26458… mm
    return s.note;
  };
  assert.equal(assumed(png(ihdr(4, 4), idat(), iend())), "This PNG does not store its size, so 96 DPI is assumed.");
  assert.match(assumed(png(ihdr(4, 4), phys(10000, 10000, 0), idat(), iend()))!, /only the shape of its pixels/);
  assert.match(assumed(png(ihdr(4, 4), phys(0, 0, 1), idat(), iend()))!, /0 pixels per metre/);
  assert.match(assumed(png(ihdr(4, 4), phys(10000, 20000, 1), idat(), iend()))!, /not square/);
  // 1 pixel per metre: 2000 pixels would be 2000 × 1000 mm = 2 km, over the 1 km modelling range.
  assert.match(assumed(png(ihdr(2000, 1), phys(1, 1, 1), idat(), iend()))!, /1 km\)\. That is what the file says, so 96 DPI is assumed\./);
  // pHYs after the image data doesn't count (PNG spec 5.6).
  assert.match(assumed(png(ihdr(4, 4), idat(), phys(10000, 10000, 1), iend()))!, /does not store its size/);
});

test("each way a PNG header can be broken is refused with its own message", () => {
  const good = png(ihdr(4, 4), phys(10000, 10000, 1), idat(), iend());
  assert.equal(readPhysicalSize(good).source, "file");
  assert.deepEqual(refusal(() => readPhysicalSize(new TextEncoder().encode("GIF89a........"))), { code: "not-an-image", message: "This file is not a PNG or JPEG image." });
  assert.equal(refusal(() => readPhysicalSize(good.slice(0, 8))).code, "truncated"); // signature only
  assert.match(refusal(() => readPhysicalSize(good.slice(0, 20))).message, /"IHDR" chunk runs past the end/);
  assert.match(refusal(() => readPhysicalSize(png(ihdr(4, 4)))).message, /ends before its image data/);
  assert.deepEqual(refusal(() => readPhysicalSize(png(chunk("IHDR", [0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0], 1), iend()))), { code: "damaged", message: "This PNG's IHDR chunk is damaged: its checksum is wrong." });
  assert.match(refusal(() => readPhysicalSize(png(ihdr(4, 4), chunk("pHYs", [0, 0, 39, 16, 0, 0, 39, 16, 1], 1), iend()))).message, /pHYs chunk is damaged: its checksum is wrong/);
  assert.match(refusal(() => readPhysicalSize(png(chunk("IHDR", [0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0]), iend()))).message, /IHDR header is 12 bytes long instead of 13/);
  assert.match(refusal(() => readPhysicalSize(png(ihdr(4, 4), chunk("pHYs", [0, 0, 39, 16, 0, 0, 39, 16]), iend()))).message, /pHYs chunk is 8 bytes long instead of 9/);
  assert.match(refusal(() => readPhysicalSize(png(idat(), ihdr(4, 4), iend()))).message, /does not start with its IHDR/);
  assert.match(refusal(() => readPhysicalSize(png(ihdr(4, 4), ihdr(4, 4), iend()))).message, /two IHDR headers/);
  assert.match(refusal(() => readPhysicalSize(png(ihdr(0, 4), iend()))).message, /at least 1 × 1 pixels; this one says 0 × 4/);
  assert.equal(refusal(() => readPhysicalSize(png(ihdr(20000, 4), iend()))).code, "too-large");
  // A length of 0xFFFFFFFF must not be trusted (it would read far past the end).
  assert.equal(refusal(() => readPhysicalSize(png(ihdr(4, 4), [255, 255, 255, 255, 73, 68, 65, 84]))).code, "truncated");
});

test("a JPEG's JFIF density gives its size", () => {
  // 254 dots per inch: 25.4 / 254 = 0.1 mm a pixel.
  assert.deepEqual(readPhysicalSize(jpeg(jfif(1, 254, 254), sof(30, 20), sos())), { format: "jpeg", width: 30, height: 20, mmPerPixel: 0.1, source: "file", note: null });
  // 100 dots per cm = 10 per mm: 0.1 mm a pixel.
  close(readPhysicalSize(jpeg(jfif(2, 100, 100), sof(30, 20), sos())).mmPerPixel, 0.1);
  // Progressive (SOF2) frames carry the size the same way; fill bytes and restart markers are skipped.
  assert.deepEqual(readPhysicalSize(new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xd0, ...jfif(1, 254, 254), ...sof(7, 3, 0xc2)])).width, 7);
  // DHT (C4) is not a frame header, even though its marker sits among them.
  assert.equal(readPhysicalSize(jpeg(segment(0xc4, [0, 1, 2]), sof(9, 5), sos())).width, 9);
});

test("a JPEG with no usable density is assumed to be 96 DPI and says why", () => {
  const note = (bytes: Uint8Array) => readPhysicalSize(bytes).note;
  assert.equal(note(jpeg(sof(4, 4), sos())), "This JPEG does not store its size, so 96 DPI is assumed.");
  assert.match(note(jpeg(jfif(0, 1, 1), sof(4, 4), sos()))!, /only the shape of its pixels/);
  assert.match(note(jpeg(jfif(1, 0, 0), sof(4, 4), sos()))!, /0 pixels per inch/);
  assert.match(note(jpeg(jfif(1, 300, 150), sof(4, 4), sos()))!, /not square/);
  // An APP0 that isn't JFIF (another tag) is ignored.
  assert.match(note(jpeg(segment(0xe0, [...new TextEncoder().encode("JFXX"), 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), sof(4, 4), sos()))!, /does not store its size/);
});

test("each way a JPEG header can be broken is refused with its own message", () => {
  assert.equal(readPhysicalSize(jpeg(jfif(1, 254, 254), sof(4, 4), sos())).source, "file");
  assert.match(refusal(() => readPhysicalSize(new Uint8Array([0xff, 0xd8]))).message, /ends before its frame header/);
  assert.match(refusal(() => readPhysicalSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).message, /ends inside a segment header/);
  assert.match(refusal(() => readPhysicalSize(new Uint8Array([0xff, 0xd8, ...jfif(1, 254, 254)]).slice(0, 10))).message, /ends inside a segment:/);
  assert.match(refusal(() => readPhysicalSize(jpeg(jfif(1, 254, 254), sos()))).message, /no frame header before its image data/);
  assert.match(refusal(() => readPhysicalSize(new Uint8Array([0xff, 0xd8, 0x12, 0x34]))).message, /expected a marker at byte 2/);
  assert.match(refusal(() => readPhysicalSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 1, 0, 0]))).message, /impossible length 1/);
  assert.match(refusal(() => readPhysicalSize(jpeg(segment(0xc0, [8, 0, 4, 0]), sos()))).message, /frame header is 6 bytes long, too short/);
  assert.deepEqual(refusal(() => readPhysicalSize(jpeg(sof(4, 0), sos()))), { code: "unsupported", message: "This JPEG gives its height after the image data (a DNL marker), which Fission can't read yet." });
  assert.match(refusal(() => readPhysicalSize(jpeg(sof(0, 4), sos()))).message, /at least 1 × 1 pixels/);
  assert.equal(refusal(() => readPhysicalSize(jpeg(sof(65535, 1), sos()))).code, "too-large");
});
