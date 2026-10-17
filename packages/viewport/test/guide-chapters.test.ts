import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAPTERS, cameraDistance, chapterAt, chapterForKey, glossary, stageLayout, termPattern, type Chapter } from "../src/guide/chapters.ts";
import { SCENE_IDS } from "../src/guide/scenes.ts";

const words = (c: Chapter) => [c.title, ...c.text].join(" ");

test("every chapter has an id of its own, a title, words, a known scene and a sky colour", () => {
  assert.equal(new Set(CHAPTERS.map((c) => c.id)).size, CHAPTERS.length);
  for (const c of CHAPTERS) {
    assert.ok(c.title.length > 0 && c.text.length > 0, c.id);
    assert.ok(SCENE_IDS.includes(c.scene), `${c.id}: unknown scene ${c.scene}`);
    assert.match(c.tint, /^#[0-9a-f]{6}$/, c.id);
  }
});

test("the guide explains the words Ben asked about and the kernel's main ideas", () => {
  const terms = new Set(glossary().map((t) => t.term));
  for (const t of ["B-rep", "Rust", "WebAssembly", "sketch", "profile", "extrude", "kernel", "face", "edge", "vertex", "topology", "coedge", "loop", "tolerance", "validation", "mesh", "NURBS", "placement", "boolean", "constraint", "timeline", "topological naming", "divergence theorem", "fuzzing", "oracle", "mutation testing"])
    assert.ok(terms.has(t), `${t} is not explained`);
});

test("every special word is explained in the first chapter that uses it, never later", () => {
  CHAPTERS.forEach((c, at) => {
    for (const t of c.terms) {
      const re = termPattern(t);
      assert.ok(re.test(words(c)), `${c.id} explains "${t.term}" but never uses it`);
      for (const earlier of CHAPTERS.slice(0, at)) assert.ok(!re.test(words(earlier)), `"${t.term}" is used in ${earlier.id} before ${c.id} explains it`);
    }
  });
});

test("a word used before its chapter is caught (the check can fail)", () => {
  const early: Chapter = { ...CHAPTERS[0], text: ["The kernel is fast."] };
  const late = CHAPTERS.find((c) => c.terms.some((t) => t.term === "kernel"))!;
  const re = termPattern(late.terms.find((t) => t.term === "kernel")!);
  assert.ok(re.test(words(early)));
  // A word that only contains the term is not a use: "kernels" is, "kernelish" is not.
  assert.ok(re.test("two kernels"));
  assert.ok(!re.test("kernelish"));
  // B-rep's hyphen is part of the word: "B-reps" counts, "rep" alone does not match it.
  assert.ok(termPattern({ term: "B-rep", meaning: "" }).test("B-reps"));
  assert.ok(!termPattern({ term: "edge", meaning: "" }).test("hedge"));
});

test("plain words: no sentence over 45 words, no chapter card over 140 words", () => {
  for (const c of CHAPTERS) {
    const all = c.text.join(" ");
    assert.ok(all.split(/\s+/).length <= 140, `${c.id} is too long to read on a card`);
    for (const s of all.split(/(?<=[.!?])\s+/)) assert.ok(s.split(/\s+/).length <= 45, `${c.id}: "${s}" is a long sentence`);
  }
});

test("anything not built says so in its own words (placeholders never pretend)", () => {
  for (const c of CHAPTERS) {
    const t = c.text.join(" ");
    if (c.status === "planned") assert.match(t, /not built yet/, c.id);
    if (c.status === "partly") assert.match(t, /not built yet|being built/, c.id);
  }
  // The chapters that are not built today: constraints and booleans.
  assert.deepEqual(CHAPTERS.filter((c) => c.status === "planned").map((c) => c.id), ["constraints", "booleans"]);
});

test("the facts the guide states match the kernel's numbers", () => {
  const all = CHAPTERS.map(words).join(" ");
  // kernel/src/tolerance.rs: LINEAR = 1e-5 mm = 10 nm; the modelling range 1 µm to 1 km.
  assert.match(all, /tolerance is 10 nanometres/);
  assert.match(all, /1 micrometre to 1 kilometre/);
  // The bracket's counts (checked against its B-rep in guide-scenes.test.ts).
  assert.match(all, /10 faces .* 24 edges and 16 vertices/);
  assert.match(all, /16 − 24 \+ 10 − 2 = 0/);
});

test("the glossary holds every term once, A to Z, and the last chapter shows it", () => {
  const g = glossary();
  assert.equal(g.length, CHAPTERS.reduce((n, c) => n + c.terms.length, 0));
  assert.equal(new Set(g.map((t) => t.term.toLowerCase())).size, g.length, "a term is explained twice");
  for (let i = 1; i < g.length; i++) assert.ok(g[i - 1].term.localeCompare(g[i].term, "en", { sensitivity: "base" }) <= 0);
  assert.equal(CHAPTERS.at(-1)!.id, "words");
});

test("chapterAt: the chapter under the middle of the screen, and how far through it", () => {
  // Three chapters 1000 px tall at 0, 1000, 2000; an 800 px screen, so the middle is scrollTop + 400.
  const tops = [0, 1000, 2000];
  const heights = [1000, 1000, 1000];
  assert.deepEqual(chapterAt(0, 800, tops, heights), { index: 0, progress: 0.4 });
  // scrollTop 600: middle at 1000, exactly the top of chapter 2, so it has just begun.
  assert.deepEqual(chapterAt(600, 800, tops, heights), { index: 1, progress: 0 });
  // scrollTop 1850: middle at 2250, a quarter into chapter 3.
  assert.deepEqual(chapterAt(1850, 800, tops, heights), { index: 2, progress: 0.25 });
  // Past the end: clamped to 1.
  assert.deepEqual(chapterAt(5000, 800, tops, heights), { index: 2, progress: 1 });
  assert.deepEqual(chapterAt(0, 800, [], []), { index: 0, progress: 0 });
});

test("chapterForKey: arrows, pages, Space, Home and End move; other keys don't; the ends hold", () => {
  assert.equal(chapterForKey("ArrowDown", 3, 10), 4);
  assert.equal(chapterForKey(" ", 3, 10), 4);
  assert.equal(chapterForKey("PageUp", 3, 10), 2);
  assert.equal(chapterForKey("ArrowLeft", 0, 10), 0);
  assert.equal(chapterForKey("ArrowRight", 9, 10), 9);
  assert.equal(chapterForKey("Home", 7, 10), 0);
  assert.equal(chapterForKey("End", 2, 10), 9);
  assert.equal(chapterForKey("l", 2, 10), null);
  assert.equal(chapterForKey("?", 2, 10), null);
});

test("cameraDistance: by hand, a unit ball in a 60° view", () => {
  // Square screen: both half-angles are 30°, so d = 1 / sin 30° = 2.
  assert.ok(Math.abs(cameraDistance(1, 60, 1) - 2) < 1e-12);
  // Half as wide as tall: tan(h) = 0.5 · tan 30° = 1/(2√3), and 1/sin h = √(1 + tan²h)/tan h = √13 = 3.60555…
  assert.ok(Math.abs(cameraDistance(1, 60, 0.5) - Math.sqrt(13)) < 1e-12);
  // Wider than tall: the vertical angle still decides, so the same 2.
  assert.ok(Math.abs(cameraDistance(1, 60, 2) - 2) < 1e-12);
});

test("stageLayout: the scene beside the words when wide, above them when narrow or upright", () => {
  assert.equal(stageLayout(1280, 800).centreX, 0.62);
  assert.equal(stageLayout(375, 800).centreY, 0.3);
  assert.equal(stageLayout(800, 1100).centreY, 0.3);
  // 760 px is wide enough; 759 is not (the CSS breaks at the same width).
  assert.equal(stageLayout(760, 600).centreX, 0.62);
  assert.equal(stageLayout(759, 600).centreX, 0.5);
});
