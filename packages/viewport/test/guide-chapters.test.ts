import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAPTERS, PLAY_SPEED, blendAt, cameraDistance, chapterAt, chapterForKey, glideAt, glideDuration, glossary, playStep, restingScroll, stageLayout, termPattern, type Chapter } from "../src/guide/chapters.ts";
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

test("restingScroll: by hand, where a card's top reaches its sticky place", () => {
  // A chapter starting 2000 px down with no padding, its card sticking 104 px below the top of the view:
  // the card's top is 2000 − scroll px down the screen, which is 104 when scroll = 1896.
  assert.equal(restingScroll(2000, 0, 104), 1896);
  // The first chapter at 0 with 104 px of padding above its card rests at scroll 0 (it starts in place).
  assert.equal(restingScroll(0, 104, 104), 0);
  // Never negative: a card already lower than its place at scroll 0 is at rest from the start.
  assert.equal(restingScroll(0, 50, 400), 0);
  // Rounded to a whole pixel, as the browser scrolls.
  assert.equal(restingScroll(1000.4, 0, 0), 1000);
  assert.equal(restingScroll(1000.6, 0, 0), 1001);
});

test("chapterAt: a chapter takes over `lead` before its words rest, and runs 0 at rest to 1 where the next takes over", () => {
  // Three chapters resting at 0, 1000 and 2000, each taking over 300 px early; the scroll ends at 2600.
  const rests = [0, 1000, 2000];
  const leads = [300, 300, 300];
  assert.deepEqual(chapterAt(0, rests, leads, 2600), { index: 0, progress: 0 });
  // Chapter 1 runs from rest 0 until chapter 2 takes over at 1000 − 300 = 700, so scroll 350 is halfway.
  assert.deepEqual(chapterAt(350, rests, leads, 2600), { index: 0, progress: 0.5 });
  // Just before the takeover the first chapter is all but done; at 700 the second has taken over, its words still sliding (progress held at 0).
  assert.deepEqual(chapterAt(699, rests, leads, 2600), { index: 0, progress: 699 / 700 });
  assert.deepEqual(chapterAt(700, rests, leads, 2600), { index: 1, progress: 0 });
  assert.deepEqual(chapterAt(999, rests, leads, 2600), { index: 1, progress: 0 });
  // At rest, exactly 0; a quarter of the way from 1000 to 1700 is 1175.
  assert.deepEqual(chapterAt(1000, rests, leads, 2600), { index: 1, progress: 0 });
  assert.deepEqual(chapterAt(1175, rests, leads, 2600), { index: 1, progress: 0.25 });
  // The last chapter runs to the end of the scroll: 2300 is halfway from 2000 to 2600; past the end, clamped.
  assert.deepEqual(chapterAt(2300, rests, leads, 2600), { index: 2, progress: 0.5 });
  assert.deepEqual(chapterAt(5000, rests, leads, 2600), { index: 2, progress: 1 });
  // A chapter with no room (the next takes over before it rests) stays at 0 rather than dividing by zero or going negative.
  // Here chapter 3 takes over at 1200 − 300 = 900, before chapter 2 would rest at 1000; between 700 and 900 chapter 2 shows at 0.
  assert.deepEqual(chapterAt(800, [0, 1000, 1200], leads, 2600), { index: 1, progress: 0 });
  assert.deepEqual(chapterAt(0, [], [], 0), { index: 0, progress: 0 });
});

test("glideAt: eases from start to target, halfway at half time, and ends exactly on the target", () => {
  // Cubic ease in-out: 4x³ for the first half, so at a quarter of the time 4 · (1/4)³ = 1/16 of the way: 0 → 1600 is at 100.
  assert.equal(glideAt(0, 1600, 250, 1000), 100);
  // Halfway in time is halfway in distance (4 · (1/2)³ = 1/2), and the end mirrors the start: at 3/4, 1 − 1/16 = 15/16.
  assert.equal(glideAt(0, 1600, 500, 1000), 800);
  assert.equal(glideAt(0, 1600, 750, 1000), 1500);
  // Exactly on the target at the end and after it (never overshooting), and at the start before it; backwards works the same.
  assert.equal(glideAt(300, 1977, 1000, 1000), 1977);
  assert.equal(glideAt(300, 1977, 5000, 1000), 1977);
  assert.equal(glideAt(300, 1977, -10, 1000), 300);
  assert.equal(glideAt(1600, 0, 250, 1000), 1500);
  // It never goes backwards on the way.
  let last = -1;
  for (let t = 0; t <= 1000; t += 10) {
    const y = glideAt(0, 1000, t, 1000);
    assert.ok(y >= last, `went back at ${t} ms`);
    last = y;
  }
});

test("glideDuration: 450 ms plus 160 ms a screen, between 600 and 1000 ms", () => {
  // Two and a half screens (the gap between chapters): 450 + 160 · 2.5 = 850 ms.
  assert.equal(glideDuration(2000, 800), 850);
  assert.equal(glideDuration(-2000, 800), 850);
  // A tiny step still takes 600 ms; a long jump is capped at 1000 ms.
  assert.equal(glideDuration(10, 800), 600);
  assert.equal(glideDuration(20000, 800), 1000);
});

test("playStep: by hand, a steady 0.15 screens a second, held to the end of the page", () => {
  assert.equal(PLAY_SPEED, 0.15);
  // An 800 px screen: 0.15 × 800 = 120 px a second, so one 16 ms frame moves 120 × 0.016 = 1.92 px.
  assert.ok(Math.abs(playStep(1000, 16, 800, 9000) - 1001.92) < 1e-9);
  // 50 ms: 6 px. Steady: ten 10 ms steps land where one 100 ms step does (12 px).
  assert.ok(Math.abs(playStep(0, 50, 800, 9000) - 6) < 1e-9);
  let y = 0;
  for (let k = 0; k < 10; k++) y = playStep(y, 10, 800, 9000);
  assert.ok(Math.abs(y - playStep(0, 100, 800, 9000)) < 1e-9 && Math.abs(y - 12) < 1e-9);
  // A frame held up for 2 s moves no more than a quarter of a second's worth (30 px): no lurch.
  assert.ok(Math.abs(playStep(0, 2000, 800, 9000) - 30) < 1e-9);
  // Never past the end, never backwards.
  assert.equal(playStep(8995, 100, 800, 9000), 9000);
  assert.equal(playStep(500, -40, 800, 9000), 500);
});

test("blendAt: smoothstep from the old scene to the new one", () => {
  // 3x² − 2x³: at a quarter, 3/16 − 2/64 = 10/64 = 0.15625; halfway 1/2; at three quarters 54/64 = 0.84375.
  assert.equal(blendAt(0, 700), 0);
  assert.equal(blendAt(175, 700), 0.15625);
  assert.equal(blendAt(350, 700), 0.5);
  assert.equal(blendAt(525, 700), 0.84375);
  assert.equal(blendAt(700, 700), 1);
  assert.equal(blendAt(9999, 700), 1);
  assert.equal(blendAt(-5, 700), 0);
  // No blend at all (reduced motion asks for none): straight to the new scene.
  assert.equal(blendAt(0, 0), 1);
});

test("chapterForKey: arrows, pages, Home and End move; other keys don't; the ends hold", () => {
  assert.equal(chapterForKey("ArrowDown", 3, 10), 4);
  assert.equal(chapterForKey(" ", 3, 10), null); // Space plays the guide (playStep) instead of jumping
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
  // By default the words start 54% down: centre (6 + 54) / 2 = 30%.
  assert.ok(Math.abs(stageLayout(375, 800).centreY - 0.3) < 1e-12);
  assert.ok(Math.abs(stageLayout(800, 1100).centreY - 0.3) < 1e-12);
  // 760 px is wide enough; 759 is not (the CSS breaks at the same width).
  assert.equal(stageLayout(760, 600).centreX, 0.62);
  assert.equal(stageLayout(759, 600).centreX, 0.5);
  // Narrow: the scene fills the band from the top bar (6%) to where the words start, centred in it.
  // Words from 40% down: centre (6 + 40) / 2 = 23%, height 40 − 6 = 34%.
  const band = stageLayout(375, 667, 0.4);
  assert.ok(Math.abs(band.centreY - 0.23) < 1e-12 && Math.abs(band.areaH - 0.34) < 1e-12);
  // Wide screens ignore it: the words are beside the scene, not under it.
  assert.deepEqual(stageLayout(1280, 800, 0.4), stageLayout(1280, 800));
});
