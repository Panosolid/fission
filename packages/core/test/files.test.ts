import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedFormat, FILE_FORMATS, identifyFile, routeFiles, type FileFormat, type FileHead, type FileImporter, type Identified } from "../src/model/files.ts";
import { RepresentationRegistry } from "../src/model/representation.ts";
import { emptyProject, projectToJson } from "../src/model/project.ts";

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
/** A whole file as identifyFile sees it (head = all of it: these are small). */
const file = (name: string, content: Uint8Array | string): FileHead => {
  const head = typeof content === "string" ? bytes(content) : content;
  return { name, size: head.length, head };
};
const is = (format: FileFormat): Identified => ({ ok: true, format });
const renamed = (claimed: FileFormat): Identified => ({ ok: false, reason: "renamed", claimed });
const unknown: Identified = { ok: false, reason: "unknown" };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A binary STL: 80 header bytes (spaces), the count little-endian, `size - 84` more bytes. */
function binaryStl(count: number, size: number, header = " ".repeat(80)): Uint8Array {
  const b = new Uint8Array(size);
  b.set(bytes(header.slice(0, 80)));
  new DataView(b.buffer).setUint32(80, count, true);
  return b;
}

test("the name's claim, worked out by hand", () => {
  // "plate.fission.json" ends in ".fission.json": a project. Plain ".json" is not in the table.
  assert.equal(claimedFormat("plate.fission.json"), "project");
  assert.equal(claimedFormat("PLATE.FISSION.JSON"), "project"); // case doesn't matter
  assert.equal(claimedFormat("data.json"), null); // plain JSON could be anything
  assert.equal(claimedFormat("photo.JPEG"), "jpeg");
  assert.equal(claimedFormat("photo.jpg"), "jpeg");
  assert.equal(claimedFormat("bracket.stp"), "step");
  assert.equal(claimedFormat(".png"), null); // a name that is only an extension names nothing
  assert.equal(claimedFormat("png"), null);
  assert.equal(claimedFormat("archive.png.zip"), null); // only the end counts
});

test("strong signatures decide alone, whatever the name says", () => {
  // PNG's 8 signature bytes (PNG spec section 5.2): 137 'P' 'N' 'G' CR LF 26 LF.
  assert.deepEqual(identifyFile(file("x.dat", new Uint8Array([...PNG, 0, 0, 0, 13]))), is("png"));
  // A JPEG starts with SOI (FF D8) and the next marker's FF.
  assert.deepEqual(identifyFile(file("photo.png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))), is("jpeg")); // misnamed, but the contents say JPEG
  assert.deepEqual(identifyFile(file("doc", "%PDF-1.7\n")), is("pdf"));
  assert.deepEqual(identifyFile(file("part.txt", "ISO-10303-21;\nHEADER;\n")), is("step"));
  // A project as the app saves it: formatVersion is its first key.
  assert.deepEqual(identifyFile(file("backup.json", projectToJson(emptyProject()))), is("project"));
  // A UTF-8 byte order mark (EF BB BF) and whitespace in front change nothing.
  assert.deepEqual(identifyFile(file("p", '\xef\xbb\xbf \n {"formatVersion": 2}')), is("project"));
  assert.deepEqual(identifyFile(file("logo", '<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), is("svg"));
  assert.deepEqual(identifyFile(file("logo", "<svg>")), is("svg"));
});

test("near misses of a strong signature are not that format", () => {
  // Seven of PNG's eight bytes, or one byte changed, is not a PNG.
  assert.deepEqual(identifyFile(file("x", new Uint8Array(PNG.slice(0, 7)))), unknown);
  assert.deepEqual(identifyFile(file("x.png", new Uint8Array([...PNG.slice(0, 7), 0x0b]))), renamed("png"));
  assert.deepEqual(identifyFile(file("x", new Uint8Array([0xff, 0xd8, 0xfe]))), unknown);
  // <svgfoo> is a different element; an <svg> inside an HTML page is a page, not a drawing.
  assert.deepEqual(identifyFile(file("x.svg", "<svgfoo/>")), renamed("svg"));
  assert.deepEqual(identifyFile(file("page.html", "<html><body><svg/></body></html>")), unknown);
  // An unclosed comment before the element: the element is never reached.
  assert.deepEqual(identifyFile(file("x.svg", "<!-- <svg/>")), renamed("svg"));
  // JSON that isn't a project, and "formatVersion" in text that isn't JSON.
  assert.deepEqual(identifyFile(file("a.fission.json", '{"name": "x"}')), renamed("project"));
  assert.deepEqual(identifyFile(file("notes.txt", 'see "formatVersion"')), unknown);
});

test("binary STL by its size alone, worked out by hand, and only when named .stl", () => {
  // 80-byte header + 4-byte count + 50 bytes per triangle (12 floats of 4 bytes, and 2 attribute bytes):
  // one triangle is 80 + 4 + 50 = 134 bytes; two are 184; none is 84.
  assert.deepEqual(identifyFile(file("part.stl", binaryStl(1, 134))), is("stl"));
  assert.deepEqual(identifyFile(file("part.stl", binaryStl(2, 184))), is("stl"));
  assert.deepEqual(identifyFile(file("empty.stl", binaryStl(0, 84))), is("stl"));
  // One byte short or over: the count and the size disagree.
  assert.deepEqual(identifyFile(file("part.stl", binaryStl(1, 133))), renamed("stl"));
  assert.deepEqual(identifyFile(file("part.stl", binaryStl(1, 135))), renamed("stl"));
  // Shorter than the header and count.
  assert.deepEqual(identifyFile(file("part.stl", new Uint8Array(83))), renamed("stl"));
  // The same bytes with another name are just bytes.
  assert.deepEqual(identifyFile(file("part.bin", binaryStl(1, 134))), unknown);
  // Only the first HEAD_BYTES are read: the size comes from the file, the count from its head.
  const big = binaryStl(1000, 100);
  assert.deepEqual(identifyFile({ name: "big.stl", size: 84 + 50 * 1000, head: big }), is("stl"));
  // Some exporters start a binary STL's header with "solid": still an STL.
  assert.deepEqual(identifyFile(file("part.stl", binaryStl(1, 134, "solid exported".padEnd(80)))), is("stl"));
});

test("ASCII STL and DXF need their extension: their signatures are too weak alone", () => {
  const stl = "solid cube\n  facet normal 0 0 1\n";
  assert.deepEqual(identifyFile(file("cube.stl", stl)), is("stl"));
  assert.deepEqual(identifyFile(file("cube.txt", stl)), unknown);
  assert.deepEqual(identifyFile(file("cube.stl", "solid")), is("stl")); // the word alone, then the end
  assert.deepEqual(identifyFile(file("notes.stl", "solidarity")), renamed("stl")); // a longer word is not the keyword
  // A text DXF opens with group code 0 and the value SECTION, one per line, padded or not, LF or CRLF.
  const dxf = "  0\r\nSECTION\r\n  2\r\nHEADER\r\n";
  assert.deepEqual(identifyFile(file("plate.dxf", dxf)), is("dxf"));
  assert.deepEqual(identifyFile(file("plate.dxf", "\n\n0\nSECTION\n")), is("dxf"));
  assert.deepEqual(identifyFile(file("plate", dxf)), unknown);
  assert.deepEqual(identifyFile(file("plate.dxf", "0\nENDSEC\n")), renamed("dxf"));
});

test("empty and unnamed files", () => {
  assert.deepEqual(identifyFile(file("blank.png", "")), renamed("png"));
  assert.deepEqual(identifyFile(file("blank", "")), unknown);
});

/** An importer that records what it was given. */
function importer(formats: FileFormat[], workspace: FileImporter["workspace"]): FileImporter & { opened: string[] } {
  const opened: string[] = [];
  return { formats, workspace, opened, open: async (name) => void opened.push(name) };
}
const refusal = (registry: RepresentationRegistry, f: FileHead) => {
  const r = routeFiles(registry, [f]);
  assert.equal(r?.kind, "refused");
  return r.kind === "refused" ? r.message : "";
};

test("routing: a registered importer takes its formats; the rest are refused with what will take them", async () => {
  const registry = new RepresentationRegistry();
  const shell = importer(["project"], null);
  const image = importer(["png", "jpeg"], "image");
  registry.registerImporter(shell);
  registry.registerImporter(image);
  const png = routeFiles(registry, [file("photo.png", new Uint8Array([...PNG]))]);
  assert.ok(png?.kind === "open" && png.importer === image && png.format === "png");
  const project = routeFiles(registry, [file("plate.fission.json", projectToJson(emptyProject()))]);
  assert.ok(project?.kind === "open" && project.importer === shell);
  // The messages, written out in full.
  assert.equal(refusal(registry, file("part.stl", "solid x\n")), "Couldn't open “part.stl”: Panoshape can't open STL meshes yet. Design will take them as mesh bodies.");
  assert.equal(refusal(registry, file("logo.svg", "<svg/>")), "Couldn't open “logo.svg”: Panoshape can't open SVG drawings yet. Vector and Laser will take them as outlines.");
  assert.equal(refusal(registry, file("plate.dxf", "0\nSECTION\n")), "Couldn't open “plate.dxf”: Panoshape can't open DXF drawings yet. Laser will take them as outlines.");
  assert.equal(refusal(registry, file("bracket.step", "ISO-10303-21;")), "Couldn't open “bracket.step”: Panoshape can't open STEP models yet. Design will take them as exact solids.");
  assert.equal(refusal(registry, file("poster.pdf", "%PDF-1.4")), "Couldn't open “poster.pdf”: Panoshape can't open PDF documents yet. Layout will take them as pages.");
  assert.equal(refusal(registry, file("notes.docx", "PK\x03\x04")), "Couldn't open “notes.docx”: Panoshape doesn't know this type of file. It opens Panoshape projects (.fission.json), PNG images and JPEG images.");
  assert.equal(refusal(registry, file("photo.png", "GIF89a")), "Couldn't open “photo.png”: it is named like a PNG image, but its contents aren't one (it may be damaged, or renamed from another type).");
  // Routing opens nothing by itself.
  assert.deepEqual([shell.opened, image.opened], [[], []]);
});

test("routing: one file at a time, nothing for nothing, and the lists follow what is registered", () => {
  const registry = new RepresentationRegistry();
  assert.equal(routeFiles(registry, []), null);
  const two = routeFiles(registry, [file("a.png", ""), file("b.png", "")]);
  assert.deepEqual(two, { kind: "refused", message: "Drop or paste one file at a time (there were 2)." });
  assert.equal(refusal(registry, file("x", "?")), "Couldn't open “x”: Panoshape doesn't know this type of file. It can't open any files yet.");
  assert.equal(refusal(registry, file("p.fission.json", '{"formatVersion":2}')), "Couldn't open “p.fission.json”: nothing here opens Panoshape projects (.fission.json).");
  // A PNG with nobody registered for it is refused naming Image, the workspace that takes images.
  assert.equal(refusal(registry, file("a.png", new Uint8Array(PNG))), "Couldn't open “a.png”: Panoshape can't open PNG images yet. Image will take them as images.");
  registry.registerImporter(importer(["jpeg"], "image"));
  assert.equal(refusal(registry, file("x", "?")), "Couldn't open “x”: Panoshape doesn't know this type of file. It opens JPEG images.");
});

test("one importer per format: a second is refused and the first stays", () => {
  const registry = new RepresentationRegistry();
  const first = importer(["png"], "image");
  registry.registerImporter(first);
  assert.throws(() => registry.registerImporter(importer(["jpeg", "png"], "vector")), /png files already have an importer/);
  assert.equal(registry.importerFor("png"), first);
  assert.equal(registry.importerFor("jpeg"), null); // nothing of the refused importer was kept
});

test("the format table: lower-case extensions, none ending another (so a name claims at most one format), and every format but projects names who will take it", () => {
  const seen = new Set<string>();
  for (const f of FILE_FORMATS) {
    for (const ext of f.extensions) {
      assert.match(ext, /^\.[a-z.]+$/, ext);
      assert.ok(!seen.has(ext), `${ext} is claimed twice`);
      for (const other of FILE_FORMATS.flatMap((g) => g.extensions)) if (other !== ext) assert.ok(!other.endsWith(ext), `${other} ends with ${ext}`);
      seen.add(ext);
      assert.equal(claimedFormat(`a${ext}`), f.format);
    }
    assert.equal(f.planned.workspaces.length === 0, f.format === "project", f.format);
  }
});

// Seeded random files built by construction: each is made from a known kind
// of contents and a known kind of name, and what identifyFile must say
// follows from the rules at the top of files.ts applied to those labels
// (the model), never from parsing the bytes again.
test("seeded random files: identifyFile matches the model of the rules, and never throws", () => {
  // SplitMix64 inline (core can't import packages/testing, which imports core).
  const rng = (seed: bigint) => {
    let s = seed;
    const M = (1n << 64n) - 1n;
    return () => {
      s = (s + 0x9e3779b97f4a7c15n) & M;
      let z = s;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
      return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
    };
  };
  type Kind = "png" | "jpeg" | "pdf" | "step" | "project" | "svg" | "ascii-stl" | "binary-stl" | "dxf" | "garbage" | "png-cut";
  const kinds: Kind[] = ["png", "jpeg", "pdf", "step", "project", "svg", "ascii-stl", "binary-stl", "dxf", "garbage", "png-cut"];
  const strong: Partial<Record<Kind, FileFormat>> = { png: "png", jpeg: "jpeg", pdf: "pdf", step: "step", project: "project", svg: "svg" };
  const weak: Partial<Record<Kind, FileFormat>> = { "ascii-stl": "stl", "binary-stl": "stl", dxf: "dxf" };
  const extensions = FILE_FORMATS.flatMap((f) => f.extensions);
  for (const seed of [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn]) {
    const next = rng(seed);
    const int = (n: number) => Math.floor(next() * n);
    const pick = <T>(xs: readonly T[]) => xs[int(xs.length)];
    // Tail bytes that can't start any signature (none of 0x89 0xFF % I { < whitespace s 0 or a BOM).
    const tail = (n: number) => Array.from({ length: n }, () => 0x41 + int(26));
    for (let step = 0; step < 2000; step++) {
      const kind = pick(kinds);
      const pad = " \n\t".slice(0, int(4)); // leading whitespace, where the format allows it
      let content: number[];
      switch (kind) {
        case "png":
          content = [...PNG, ...tail(int(20))];
          break;
        case "png-cut": {
          // A strict prefix of the PNG signature, or the signature with one byte changed (XOR with 1..255 always changes it).
          const at = int(8);
          content = int(2) ? PNG.slice(0, at) : PNG.map((b, i) => (i === at ? b ^ (1 + int(255)) : b));
          break;
        }
        case "jpeg":
          content = [0xff, 0xd8, 0xff, ...tail(int(20))];
          break;
        case "pdf":
          content = [...bytes(`%PDF-1.${int(8)}`), ...tail(int(20))];
          break;
        case "step":
          content = [...bytes(`${pad}ISO-10303-21;`), ...tail(int(20))];
          break;
        case "project":
          content = [...bytes(`${pad}{"formatVersion": ${int(5)}, "name": "`), ...tail(int(20))];
          break;
        case "svg":
          content = [...bytes(`${pad}${int(2) ? '<?xml version="1.0"?>' : ""}${int(2) ? "<!-- x -->" : ""}<svg${pick([" ", ">", "/"])}`), ...tail(int(20))];
          break;
        case "ascii-stl":
          // The keyword, then a space or newline and more, or the keyword alone at the end.
          content = int(3) ? [...bytes(`${pad}solid${pick([" ", "\n"])}`), ...tail(int(20))] : [...bytes(`${pad}solid`)];
          break;
        case "binary-stl": {
          const count = int(4);
          content = Array.from(binaryStl(count, 84 + 50 * count, "A".repeat(80)));
          break;
        }
        case "dxf":
          content = [...bytes(`${pad}0\nSECTION\n`), ...tail(int(20))];
          break;
        case "garbage": {
          content = tail(int(200));
          if (content.length >= 84) content.splice(80, 4, 0xff, 0xff, 0xff, 0xff); // a count no size here can match
          break;
        }
      }
      const naming = int(4); // 0: the kind's own extension, 1: another format's, 2: an unknown one, 3: none
      const own = kind in strong ? strong[kind] : kind in weak ? weak[kind] : null;
      const ownExt = own ? pick(FILE_FORMATS.find((f) => f.format === own)!.extensions) : null;
      const ext = naming === 0 && ownExt ? ownExt : naming === 1 ? pick(extensions.filter((e) => e !== ownExt)) : naming === 2 ? pick([".txt", ".zip", ".json", ".bin"]) : "";
      const name = `${pick(["part", "Logo", "a b", "x.y"])}${int(2) ? ext : ext.toUpperCase()}`;
      const claim = FILE_FORMATS.find((f) => f.extensions.includes(ext))?.format ?? null;
      // The model: strong contents decide; weak contents need their own extension; else the claim is refused as renamed, or the file is unknown.
      const expected: Identified = strong[kind]
        ? is(strong[kind]!)
        : weak[kind] && claim === weak[kind]
          ? is(weak[kind]!)
          : claim
            ? renamed(claim)
            : unknown;
      const f = { name, size: content.length, head: new Uint8Array(content) };
      assert.deepEqual(identifyFile(f), expected, `seed ${seed} step ${step}: ${kind} named ${JSON.stringify(name)}`);
      // And raw random bytes under a random name never throw.
      const raw = new Uint8Array(Array.from({ length: int(300) }, () => int(256)));
      assert.doesNotThrow(() => identifyFile({ name: String.fromCharCode(...Array.from({ length: int(12) }, () => int(0x3000))), size: raw.length + int(3) * 50, head: raw }));
    }
  }
});
