// Reads an image file's pixel size and physical size from its headers,
// without decoding any pixels (the browser decodes; G1b checks its width and
// height against these). PNG keeps the size in IHDR and the density in an
// optional pHYs chunk (pixels per metre); JPEG keeps the size in its SOFn
// frame header and the density in an optional JFIF APP0 segment (per inch or
// per cm). Every read is bounds-checked: a damaged file gives an ImageError,
// never an out-of-range read or a hang.

import { ImageError } from "./errors.ts";
import { checkMmPerPixel, checkPixelSize } from "./limits.ts";

/** Used when a file says nothing about its size: the common screen density. */
export const ASSUMED_DPI = 96;

export const MM_PER_INCH = 25.4;

export function dpiToMmPerPixel(dpi: number): number {
  return MM_PER_INCH / dpi;
}

export function mmPerPixelToDpi(mmPerPixel: number): number {
  return MM_PER_INCH / mmPerPixel;
}

export interface PhysicalSize {
  format: "png" | "jpeg";
  /** In pixels, from the file's header. */
  width: number;
  height: number;
  mmPerPixel: number;
  /** "file" when the file stored a usable density, else "assumed" (ASSUMED_DPI). */
  source: "file" | "assumed";
  /** Why the size was assumed, shown to the user; null when it came from the file. */
  note: string | null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Reads the format, pixel size and physical size of a PNG or JPEG file. */
export function readPhysicalSize(bytes: Uint8Array): PhysicalSize {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return readPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  throw new ImageError("not-an-image", "This file is not a PNG or JPEG image.");
}

function assumed(format: PhysicalSize["format"], width: number, height: number, why: string): PhysicalSize {
  return { format, width, height, mmPerPixel: dpiToMmPerPixel(ASSUMED_DPI), source: "assumed", note: `${why}, so ${ASSUMED_DPI} DPI is assumed.` };
}

/** A density the file stores; one the kernel could not model is reported and replaced, not trusted. */
function fromFile(format: PhysicalSize["format"], width: number, height: number, mmPerPixel: number): PhysicalSize {
  try {
    checkMmPerPixel(mmPerPixel, width, height);
  } catch (e) {
    if (e instanceof ImageError) return assumed(format, width, height, `${e.message} That is what the file says`);
    throw e;
  }
  return { format, width, height, mmPerPixel, source: "file", note: null };
}

const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

// ---- PNG ----

let crcTable: Uint32Array | null = null;

/** The CRC-32 PNG uses (ISO 3309, reflected polynomial 0xEDB88320) over the chunk type and data. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readPng(b: Uint8Array): PhysicalSize {
  let pos = 8;
  let size: { width: number; height: number } | null = null;
  let density: PhysicalSize | null = null;
  for (;;) {
    if (pos + 8 > b.length) throw new ImageError("truncated", "This PNG ends before its image data: the file is cut off.");
    const length = u32(b, pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const data = pos + 8;
    // A chunk's length is at most 2^31 - 1 (PNG spec 5.3); the end check also guards the CRC read.
    if (length > 0x7fffffff || data + length + 4 > b.length) {
      throw new ImageError("truncated", `This PNG's ${JSON.stringify(type)} chunk runs past the end of the file: the file is cut off.`);
    }
    if (size === null && type !== "IHDR") throw new ImageError("damaged", "This PNG does not start with its IHDR header.");
    if (type === "IHDR" || type === "pHYs") {
      if (crc32(b, pos + 4, data + length) !== u32(b, data + length)) {
        throw new ImageError("damaged", `This PNG's ${type} chunk is damaged: its checksum is wrong.`);
      }
    }
    if (type === "IHDR") {
      if (size !== null) throw new ImageError("damaged", "This PNG has two IHDR headers.");
      if (length !== 13) throw new ImageError("damaged", `This PNG's IHDR header is ${length} bytes long instead of 13.`);
      size = { width: u32(b, data), height: u32(b, data + 4) };
      checkPixelSize(size.width, size.height);
    } else if (type === "pHYs") {
      if (length !== 9) throw new ImageError("damaged", `This PNG's pHYs chunk is ${length} bytes long instead of 9.`);
      density = pngDensity(size!.width, size!.height, u32(b, data), u32(b, data + 4), b[data + 8]);
    } else if (type === "IDAT" || type === "IEND") {
      // pHYs must come before the image data (PNG spec 5.6), so the search ends here.
      return density ?? assumed("png", size!.width, size!.height, "This PNG does not store its size");
    }
    pos = data + length + 4;
  }
}

function pngDensity(width: number, height: number, xPerUnit: number, yPerUnit: number, unit: number): PhysicalSize {
  if (unit !== 1) return assumed("png", width, height, "This PNG stores only the shape of its pixels, not their size");
  if (xPerUnit === 0 || yPerUnit === 0) return assumed("png", width, height, "This PNG says 0 pixels per metre, which is not a size");
  if (xPerUnit !== yPerUnit) return assumed("png", width, height, "This PNG's pixels are not square, which Fission can't show yet");
  return fromFile("png", width, height, 1000 / xPerUnit);
}

// ---- JPEG ----

/** Frame headers that carry the size: SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function readJpeg(b: Uint8Array): PhysicalSize {
  let pos = 2;
  let jfif: { unit: number; x: number; y: number } | null = null;
  for (;;) {
    if (pos + 2 > b.length) throw new ImageError("truncated", "This JPEG ends before its frame header: the file is cut off.");
    if (b[pos] !== 0xff) throw new ImageError("damaged", `This JPEG is damaged: expected a marker at byte ${pos}.`);
    const marker = b[pos + 1];
    if (marker === 0xff) {
      pos += 1; // fill byte (JPEG spec B.1.1.2)
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // markers with no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      throw new ImageError("damaged", "This JPEG has no frame header before its image data.");
    }
    if (pos + 4 > b.length) throw new ImageError("truncated", "This JPEG ends inside a segment header: the file is cut off.");
    const length = u16(b, pos + 2);
    const data = pos + 4;
    if (length < 2) throw new ImageError("damaged", `This JPEG has a segment of impossible length ${length}.`);
    if (pos + 2 + length > b.length) throw new ImageError("truncated", "This JPEG ends inside a segment: the file is cut off.");
    if (marker === 0xe0 && jfif === null && length >= 16 && "JFIF\0".split("").every((c, i) => b[data + i] === c.charCodeAt(0))) {
      jfif = { unit: b[data + 7], x: u16(b, data + 8), y: u16(b, data + 10) };
    } else if (isSof(marker)) {
      if (length < 8) throw new ImageError("damaged", `This JPEG's frame header is ${length} bytes long, too short to hold a size.`);
      const height = u16(b, data + 1);
      const width = u16(b, data + 3);
      if (height === 0) throw new ImageError("unsupported", "This JPEG gives its height after the image data (a DNL marker), which Fission can't read yet.");
      checkPixelSize(width, height);
      return jpegDensity(width, height, jfif);
    }
    pos += 2 + length;
  }
}

function jpegDensity(width: number, height: number, jfif: { unit: number; x: number; y: number } | null): PhysicalSize {
  if (jfif === null) return assumed("jpeg", width, height, "This JPEG does not store its size");
  const perMm = jfif.unit === 1 ? 1 / MM_PER_INCH : jfif.unit === 2 ? 1 / 10 : 0;
  if (perMm === 0) return assumed("jpeg", width, height, "This JPEG stores only the shape of its pixels, not their size");
  if (jfif.x === 0 || jfif.y === 0) return assumed("jpeg", width, height, "This JPEG says 0 pixels per inch, which is not a size");
  if (jfif.x !== jfif.y) return assumed("jpeg", width, height, "This JPEG's pixels are not square, which Fission can't show yet");
  return fromFile("jpeg", width, height, 1 / (jfif.x * perMm));
}
