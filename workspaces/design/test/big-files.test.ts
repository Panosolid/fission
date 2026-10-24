// Security audit S2: a big but valid design file must not freeze the tab.
// DESIGN_LIMITS caps what a file holds, each limit refused one past it with
// its own message (and the limit itself opens), and the reader takes time
// in proportion to the file, not its square: the biggest design the limits
// allow reads in a few seconds. Files are made by `bigDesign`, so each case
// says exactly what it holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_LIMITS, readDesignDocument, type DesignDocument, type KeptShape, type Sketch } from "../src/document.ts";

interface Shape {
  /** Sketch-and-extrude pairs; each sketch holds `content` points and curves. */
  pairs: number;
  content?: number;
  /** Lone sketches after the pairs (no extrude), each with `loneContent` points and curves. */
  lone?: number;
  loneContent?: number;
  /** Kept shapes, one per pair from the first, with these many points and curves each. */
  kept?: number[];
}

/**
 * Content of n points and curves with fresh counter ids: ⌈n/2⌉ points in a
 * row, and lines joining them one after another (⌊n/2⌋ lines, so an n that
 * is odd leaves the last point loose). The kernel judges whether it closes;
 * the reader only counts and checks references.
 */
function content(n: number, take: () => number): { points: Sketch["points"]; curves: Sketch["curves"] } {
  const points = Array.from({ length: Math.ceil(n / 2) }, (_, k) => ({ id: `point-${take()}`, x: k, y: k % 2 }));
  const curves = Array.from({ length: Math.floor(n / 2) }, (_, k) => ({ id: `line-${take()}`, kind: "line" as const, start: points[k].id, end: points[(k + 1) % points.length].id }));
  return { points, curves };
}

/** A version 3 design from an empty timeline, as `shape` says. */
function bigDesign({ pairs, content: per = 6, lone = 0, loneContent = 6, kept = [] }: Shape): DesignDocument {
  let next = 1;
  const take = () => next++;
  const doc: DesignDocument = { version: 3, nextId: 1, profiles: [], sketches: [], timeline: { features: [] } };
  const extrudes: string[] = [];
  const sketch = (n: number) => {
    const id = `sketch-${take()}`;
    doc.sketches.push({ id, ...content(n, take), constraints: [] });
    doc.timeline.features.push({ id, intent: { type: "sketch", parameters: { plane: "XY" }, summary: `Sketch on the XY plane` }, provenance: { self: { workspace: "design", id, label: "Sketch" }, from: [] }, dependsOn: [], suppressed: false });
    return id;
  };
  for (let i = 0; i < pairs; i++) {
    const s = sketch(per);
    const id = `feature-${take()}`;
    doc.timeline.features.push({ id, intent: { type: "extrude", parameters: { sketch: s, distance: 5 }, summary: "Extrude" }, provenance: { self: { workspace: "design", id, label: "Extrude" }, from: [] }, dependsOn: [s], suppressed: false });
    extrudes.push(id);
  }
  for (let i = 0; i < lone; i++) sketch(loneContent);
  if (kept.length) doc.kept = Object.fromEntries(kept.map((n, i): [string, KeptShape] => [extrudes[i], content(n, take)]));
  doc.nextId = next;
  return doc;
}

/** Through JSON, as a file arrives. */
const read = (d: DesignDocument) => readDesignDocument(JSON.parse(JSON.stringify(d)));
const refused = (d: unknown, message: string) => assert.throws(() => readDesignDocument(JSON.parse(JSON.stringify(d))), { message });

test("the limits, worked from what they must hold", () => {
  // A sketch holds ten times the kernel's 2,000-corner outline: 20,000 points and curves.
  // The whole design 25 such sketches: 25 × 20,000 = 500,000. Timeline items and
  // profiles 5,000 each, far past any real part's few hundred.
  assert.deepEqual(DESIGN_LIMITS, { items: 5_000, profiles: 5_000, sketch: 20_000, content: 500_000 });
});

test("bigDesign makes what it says: 2 pairs of 6 are 4 items and 12 points and curves, ids counted from 1", () => {
  const d = bigDesign({ pairs: 2, kept: [3] });
  // sketch-1 takes ids 2..7 (3 points, 3 lines), feature-8; sketch-9 takes 10..15, feature-16; the kept shape 17..18 (2 points, 1 line).
  assert.deepEqual(d.timeline.features.map((f) => f.id), ["sketch-1", "feature-8", "sketch-9", "feature-16"]);
  assert.deepEqual(d.sketches.map((s) => s.points.length + s.curves.length), [6, 6]);
  assert.deepEqual(d.kept!["feature-8"].points.map((p) => p.id), ["point-17", "point-18"]);
  assert.equal(d.nextId, 20);
  assert.deepEqual(read(d), d);
});

test("5,000 timeline items open; 5,001 are refused before anything is checked", () => {
  // 2,500 pairs are 2 × 2,500 = 5,000 items; one lone sketch more is 5,001.
  assert.equal(read(bigDesign({ pairs: 2_500 })).timeline.features.length, 5_000);
  refused(bigDesign({ pairs: 2_500, lone: 1 }), "Design data has 5001 timeline items, more than the 5000 this SpindleLabs opens");
  // Counted first: the items are refused, not the broken sketch inside them.
  const broken = bigDesign({ pairs: 2_500, lone: 1 });
  broken.sketches[0].points[0].x = Number.NaN;
  refused(broken, "Design data has 5001 timeline items, more than the 5000 this SpindleLabs opens");
});

test("5,000 profiles open; 5,001 are refused", () => {
  const plane = { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] };
  const profiles = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `profile-${k + 1}`, kind: "rectangle", width: 1, depth: 1, plane }));
  const doc = (n: number) => ({ ...bigDesign({ pairs: 0 }), profiles: profiles(n), nextId: n + 1 });
  assert.equal(readDesignDocument(doc(5_000)).profiles.length, 5_000);
  refused(doc(5_001), "Design data has 5001 profiles, more than the 5000 this SpindleLabs opens");
});

test("more sketches than the timeline may hold are refused by their count", () => {
  // 5,001 sketches with no timeline items: refused by the count, not "has no place in the timeline".
  const d = bigDesign({ pairs: 0 });
  d.sketches = Array.from({ length: 5_001 }, (_, k) => ({ id: `sketch-${k + 1}`, points: [], curves: [], constraints: [] }));
  refused(d, "Design data has 5001 sketches, more than the 5000 this SpindleLabs opens");
});

test("a sketch of 20,000 points and curves opens; 20,001 is refused, naming the sketch", () => {
  assert.equal(read(bigDesign({ pairs: 1, content: 20_000 })).sketches[0].curves.length, 10_000);
  refused(bigDesign({ pairs: 1, content: 20_001 }), "Design sketch sketch-1 has 20001 points and curves, more than the 20000 this SpindleLabs opens");
});

test("a kept shape of 20,000 opens; 20,001 is refused, naming its extrude", () => {
  // sketch-1 takes 2..7 and feature-8 is its extrude, so the kept shape is feature-8's.
  assert.equal(Object.keys(read(bigDesign({ pairs: 1, kept: [20_000] })).kept!).length, 1);
  refused(bigDesign({ pairs: 1, kept: [20_001] }), "Design feature feature-8's kept shape has 20001 points and curves, more than the 20000 this SpindleLabs opens");
});

test("500,000 points and curves in all open; one more is refused, in sketches and in kept shapes", () => {
  // 25 sketches × 20,000 = 500,000; a 26th sketch of one point makes 500,001.
  assert.equal(read(bigDesign({ pairs: 25, content: 20_000 })).sketches.length, 25);
  refused(bigDesign({ pairs: 25, content: 20_000, lone: 1, loneContent: 1 }), "Design data's sketches have at least 500001 points and curves together, more than the 500000 this SpindleLabs opens");
  // 24 × 20,000 = 480,000 in sketches, then kept shapes of 20,000 (500,000) and 1 (500,001).
  assert.equal(Object.keys(read(bigDesign({ pairs: 24, content: 20_000, kept: [20_000] })).kept!).length, 1);
  refused(bigDesign({ pairs: 24, content: 20_000, kept: [20_000, 1] }), "Design data's sketches and kept shapes have at least 500001 points and curves together, more than the 500000 this SpindleLabs opens");
});

test("a version 1 file is counted before it is upgraded", () => {
  // Upgrading spreads every feature's id into Math.max, which overflows the
  // stack for a long list; the count refuses it first with its own message.
  const features = Array.from({ length: 300_000 }, (_, k) => ({ id: `feature-${k + 1}` }));
  refused({ version: 1, profiles: [], timeline: { features } }, "Design data has 300000 timeline items, more than the 5000 this SpindleLabs opens");
});

/** `list` behind a proxy counting reads of its items, so a test can tell one pass over it from a search per item. */
function counted<T>(list: T[]): { list: T[]; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(list, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list: proxy, reads: () => reads };
}

test("each list is read a few times over, never once per item: no search inside a loop", () => {
  // The most items (2,500 pairs) and one long sketch and kept shape. Every
  // check passes over a list a fixed number of times, so its items are read
  // at most about 20 times each (100,000 reads of 5,000 items). A search
  // per item, as the reader did before (findIndex for each extrude's
  // sketch), reads 2,500 × 2,500 = 6,250,000 times: caught.
  const d = bigDesign({ pairs: 2_500, kept: [20_000] });
  let next = d.nextId;
  Object.assign(d.sketches[0], content(20_000, () => next++)); // sketch-1, now long, with ids after all the others
  d.nextId = next;
  const opened = JSON.parse(JSON.stringify(d)) as DesignDocument;
  const features = counted(opened.timeline.features);
  const points = counted(opened.sketches[0].points);
  const kept = counted(opened.kept!["feature-8"].curves); // sketch-1's extrude
  opened.timeline.features = features.list;
  opened.sketches[0].points = points.list;
  opened.kept!["feature-8"].curves = kept.list;
  readDesignDocument(opened);
  for (const [name, c, n] of [["timeline items", features, 5_000], ["sketch points", points, 10_000], ["kept curves", kept, 10_000]] as const)
    assert.ok(c.reads() <= 20 * n, `${name}: ${c.reads()} reads of ${n}`);
});

test("the biggest design the limits allow reads in seconds", () => {
  // Made from DESIGN_LIMITS, so raising a limit makes these files bigger:
  // the most timeline items, and the most content in the longest lists
  // (sketches and kept shapes of the sketch limit each, half the total in
  // each kind). Under a second on a laptop; 10 s leaves room for a slow runner.
  const { items, sketch, content } = DESIGN_LIMITS;
  const lists = Math.floor(content / sketch / 2);
  for (const shape of [{ pairs: items / 2 }, { pairs: lists, content: sketch, kept: Array(lists).fill(sketch) }]) {
    const text = JSON.stringify(bigDesign(shape));
    const start = performance.now();
    readDesignDocument(JSON.parse(text));
    const seconds = (performance.now() - start) / 1000;
    assert.ok(seconds < 10, `${(text.length / 1e6).toFixed(1)} MB took ${seconds.toFixed(1)} s`);
  }
});
