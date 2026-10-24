// Browser check that lines hidden behind a body stay hidden (the 3D view
// draws like shaded-with-edges: only what the camera can see). Bug found by
// step 25a4: a finished sketch was drawn with no depth test, so the sketch an
// extrude was made from showed its back lines through the body, as if the
// body's hidden back edges were drawn.
//
// The file: Sketch 1, a 40 × 30 rectangle on the XY plane, extruded 20 mm
// (Body 1, 0 ≤ x ≤ 40, 0 ≤ y ≤ 30, 0 ≤ z ≤ 20), and Sketch 2 on the XY
// plane, one line from (-60, 45) to (100, 45), behind the body from the home
// view, so part of it is seen beside the body and part hidden behind it.
// Seen from the home view (the camera in front of the -Y face, to the +X
// side and above), the body's bottom back edge (y 30, z 0) and bottom left
// edge (x 0, z 0) are behind its front and right faces: Sketch 1's lines
// there must not be drawn. Its front line (y 0) lies on a visible edge.
//
// Probes, through the app's own camera (`?test-hooks`), on screen pixels
// across a line: a strip of pixels from −STRIP to +STRIP across the line,
// and a reference on each side REF px away. A line is drawn there when a
// strip pixel differs from both references by more than SHOWS in a channel;
// hidden when every strip pixel is within FLAT of both references (and the
// two references agree, so the strip lies on one face). Checked:
// 1. Sketch 1's hidden back and left lines are hidden; the same probe on
//    Sketch 2 where it is beside the body finds a line, so it can fail.
// 2. Sketch 2 is drawn where it is beside the body and hidden where it
//    passes behind it.
// 3. The visible front edge, where Sketch 1's line lies on the body's edge,
//    shows the edge's selection green once the edge is clicked, and the
//    hovered tint before (the body's edges keep their highlight when a
//    sketch line lies on them).
// At 1280 px with the mouse and 375 px with taps. In `npm run e2e` and
// `npm run e2e:engines` (Firefox and WebKit). Run with `npm run e2e` (after
// `npm run build`).
import assert from "node:assert/strict";
import { browserName, launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4211, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4211/?test-hooks#design";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;

/** Half the strip across a line, in device pixels (an antialiased line spreads over two or three). */
const STRIP = 3;
/** How far each side's reference pixel is from the line. */
const REF = 9;
/** A strip pixel this far (of 255, any channel) from both references is a drawn line. */
const SHOWS = 12;
/** Every strip pixel within this of both references is a plain face: no line. */
const FLAT = 6;

// The pinhole camera, as navigation.mjs works it: forward = unit(target −
// position), right = unit(forward × up), the screen's up = right × forward;
// a 45° vertical field of view.
const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const scale = (a, s) => a.map((x) => x * s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const T = Math.tan(Math.PI / 8);

/** Where model point `p` is on the canvas, as a fraction of its width and height from the top left. */
function onCanvas(cam, aspect, p) {
  const forward = unit(sub(cam.target, cam.position));
  const right = unit(cross(forward, cam.up));
  const up = cross(right, forward);
  const v = sub(p, cam.position);
  const nx = dot(v, right) / (dot(v, forward) * T * aspect);
  const ny = dot(v, up) / (dot(v, forward) * T);
  return [(nx + 1) / 2, (1 - ny) / 2];
}

const pts = [[0, 0], [40, 0], [40, 30], [0, 30]];
const project = {
  formatVersion: 2,
  name: "Hidden",
  units: { length: "mm" },
  materials: [],
  links: [],
  workspaces: {
    design: {
      version: 2,
      nextId: 30,
      profiles: [],
      sketches: [
        {
          id: "sketch-1",
          points: pts.map(([x, y], i) => ({ id: `point-${3 + i}`, x, y })),
          curves: pts.map((_, i) => ({ id: `line-${7 + i}`, kind: "line", start: `point-${3 + i}`, end: `point-${3 + ((i + 1) % 4)}` })),
          constraints: [],
        },
        {
          id: "sketch-12",
          points: [{ id: "point-13", x: -60, y: 15 }, { id: "point-14", x: 100, y: 15 }],
          curves: [{ id: "line-15", kind: "line", start: "point-13", end: "point-14" }],
          constraints: [],
        },
      ],
      timeline: {
        features: [
          {
            id: "sketch-1",
            intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 1 on the XY plane" },
            provenance: { self: { workspace: "design", id: "sketch-1", label: "Sketch 1" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
          {
            id: "feature-11",
            intent: { type: "extrude", parameters: { sketch: "sketch-1", distance: 20 }, summary: "Extrude: Sketch 1 by 20 mm" },
            provenance: { self: { workspace: "design", id: "feature-11", label: "Extrude 1" }, from: [{ workspace: "design", id: "sketch-1", label: "Sketch 1" }] },
            dependsOn: ["sketch-1"],
            suppressed: false,
          },
          {
            id: "sketch-12",
            intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 2 on the XY plane" },
            provenance: { self: { workspace: "design", id: "sketch-12", label: "Sketch 2" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
        ],
      },
    },
  },
};

async function fresh(width, touch) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector("#start-hint", { state: "visible", timeout: 15000 }); // the empty new project (U0c), ready for the file
  await page.setInputFiles("#open-file", { name: "Hidden.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
  await page.waitForFunction(() => document.querySelectorAll('#browser [data-node="timeline"] .tree-row').length === 3 && document.querySelector("#viewport")?.dataset.sketchLines === "5", null, { timeout: 15000 });
  // 40 · 30 · 20 = 24,000 mm³ again, the same as the box the page opened with, so wait for the timeline instead.
  return page;
}

/** The canvas's pixels (device pixels, RGBA), a frame or two after it settles, and the camera it was drawn with. */
async function grab(page) {
  await page.waitForTimeout(300);
  const cam = await page.evaluate(() => window.fissionTest.camera());
  const shot = await page.evaluate(() => {
    const src = document.querySelector("#viewport canvas");
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    return { dpr: src.width / src.getBoundingClientRect().width, width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  });
  return { cam, ...shot, at: (x, y) => Array.from(shot.data.slice(4 * (y * shot.width + x), 4 * (y * shot.width + x) + 3)) };
}

/** Body 1's twelve edges. */
const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? 40 : 0, i & 2 ? 30 : 0, i & 4 ? 20 : 0]);
const BOX_EDGES = CORNERS.flatMap((p, i) => [1, 2, 4].filter((bit) => !(i & bit)).map((bit) => [p, CORNERS[i | bit]]));
/** Whether model point `x` lies on the segment p → q (exactly: all the coordinates here are whole millimetres). */
const onSegment = (x, p, q) => {
  const d = sub(q, p);
  const c = cross(sub(x, p), d);
  const t = dot(sub(x, p), d) / dot(d, d);
  return c.every((v) => v === 0) && t >= 0 && t <= 1;
};
/** Screen distance from point s to the segment p → q. */
function screenDistance(s, p, q) {
  const d = [q[0] - p[0], q[1] - p[1]];
  const t = Math.max(0, Math.min(1, ((s[0] - p[0]) * d[0] + (s[1] - p[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])));
  return Math.hypot(s[0] - p[0] - t * d[0], s[1] - p[1] - t * d[1]);
}

const far = (a, b, d) => a.some((x, i) => Math.abs(x - b[i]) > d);

/**
 * Probes across the model line a → b at fractions `ts`, in `img`: for each,
 * the strip and both references, and the verdict "line" (a strip pixel
 * differs from both references by more than SHOWS), "flat" (every strip
 * pixel within FLAT of both, which agree), or "mixed".
 */
function probe(img, a, b, ts) {
  const edges = BOX_EDGES.filter(([p, q]) => !(onSegment(a, p, q) && onSegment(b, p, q)));
  const aspect = img.width / img.height;
  const px = (p) => {
    const [fx, fy] = onCanvas(img.cam, aspect, p);
    return [fx * img.width, fy * img.height];
  };
  const inside = (x, y) => x >= 2 * REF && y >= 2 * REF && x < img.width - 2 * REF && y < img.height - 2 * REF && !(x > img.width - 130 * img.dpr && y < 130 * img.dpr);
  return ts.flatMap((t) => {
    const p = add(a, scale(sub(b, a), t));
    const [x, y] = px(p);
    if (!inside(x, y)) return []; // off the canvas, or under the view cube
    if (edges.some(([p, q]) => screenDistance([x, y], px(p), px(q)) < REF + 2)) return []; // a body edge within reach would look like this line
    const [x2, y2] = px(add(p, scale(sub(b, a), 0.01)));
    const len = Math.hypot(x2 - x, y2 - y);
    const n = [-(y2 - y) / len, (x2 - x) / len];
    const pixel = (k) => {
      const [qx, qy] = [Math.round(x + n[0] * k), Math.round(y + n[1] * k)];
      assert.ok(qx >= 0 && qy >= 0 && qx < img.width && qy < img.height, `probe ${p} at (${qx}, ${qy}) is off the canvas`);
      return img.at(qx, qy);
    };
    const refs = [pixel(-REF), pixel(REF)];
    const strip = Array.from({ length: 2 * STRIP + 1 }, (_, i) => pixel(i - STRIP));
    const line = strip.some((s) => refs.every((r) => far(s, r, SHOWS)));
    const flat = !far(refs[0], refs[1], FLAT) && strip.every((s) => refs.every((r) => !far(s, r, FLAT)));
    return [{ t, at: [Math.round(x), Math.round(y)], refs, strip, verdict: line ? "line" : flat ? "flat" : "mixed" }];
  });
}

const ts = Array.from({ length: 13 }, (_, i) => 0.2 + (0.6 * i) / 12);
const say = (r) => r.map((p) => `t ${p.t.toFixed(2)} at ${p.at}: ${p.verdict} (refs ${JSON.stringify(p.refs)}, strip ${JSON.stringify(p.strip)})`).join("\n  ");
const MEASURE = process.env.E2E_MEASURE === "1";

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.stack ?? e}`);
  }
}

try {
  for (const [width, touch] of [[1280, false], [375, true]])
    await check(`hidden lines stay hidden, visible ones and edge highlights still drawn (${width} px${touch ? ", taps" : ""})`, async () => {
      const page = await fresh(width, touch);
      try {
        const img = await grab(page);
        if (shots) await page.locator("#viewport canvas").screenshot({ path: `${shots}/hidden-edges-${width}.png` });
        const back = probe(img, [0, 30, 0], [40, 30, 0], ts);
        const left = probe(img, [0, 0, 0], [0, 30, 0], ts);
        // Sketch 2's line: where the body can't hide it (beside it), and where it passes behind.
        const along = Array.from({ length: 161 }, (_, i) => i / 160);
        const beside = probe(img, [-60, 15, 0], [100, 15, 0], along).filter((p) => p.refs.every((r) => !far(r, img.at(2, 2), FLAT)));
        const behind = probe(img, [-60, 15, 0], [100, 15, 0], along).filter((p) => p.refs.every((r) => far(r, img.at(2, 2), 3 * SHOWS)));
        if (MEASURE) console.log(`back\n  ${say(back)}\nleft\n  ${say(left)}\nbeside\n  ${say(beside)}\nbehind\n  ${say(behind)}`);

        // The probes can fail: Sketch 2 beside the body is a line to them.
        assert.ok(beside.length >= 3, `Sketch 2 should be beside the body at 3 probes or more:\n  ${say(beside)}`);
        assert.ok(beside.every((p) => p.verdict === "line"), `Sketch 2 beside the body should be drawn:\n  ${say(beside)}`);
        assert.ok(behind.length >= 3, `Sketch 2 should pass behind the body at 3 probes or more`);
        // Hidden: every probe lying on one face (both references agree) sees a plain face, and there are at least 3 such.
        for (const [what, r] of [["Sketch 1's back line (behind the body)", back], ["Sketch 1's left line (behind the body)", left], ["Sketch 2 behind the body", behind]]) {
          const onOneFace = r.filter((p) => !far(p.refs[0], p.refs[1], FLAT));
          const shown = onOneFace.filter((p) => p.verdict !== "flat");
          assert.equal(shown.length, 0, `${what} is drawn through the body:\n  ${say(shown)}`);
          assert.ok(onOneFace.length >= 3, `${what}: too few probes on one face:\n  ${say(r)}`);
        }

        // The front bottom edge, where Sketch 1's front line lies on it: hovered (mouse only), then picked.
        const front = [[0, 0, 0], [40, 0, 0]];
        const spot = probe(img, ...front, [0.5])[0];
        assert.ok(spot, "the front edge's middle is on the canvas, clear of other edges");
        const box = await page.locator("#viewport canvas").boundingBox();
        const [cx, cy] = [box.x + spot.at[0] / img.dpr, box.y + spot.at[1] / img.dpr];
        const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [cx, cy]);
        assert.equal(under, "CANVAS", "the front edge's middle is under the canvas, not a panel");
        const greenest = (r) => Math.max(...r.flatMap((p) => p.strip.map(([red, g, b]) => g - (red + b) / 2)));
        const plain = greenest(probe(img, ...front, ts));
        assert.ok(plain < 15, `the front edge is not green before it is hovered or picked (${plain})`);
        if (!touch) {
          await page.mouse.move(cx, cy);
          await page.waitForFunction(() => /^edge \d+$/.test(document.querySelector("#viewport").dataset.hover ?? ""), null, { timeout: 5000 });
          // Hovered: EDGE_COLOUR halfway to SELECTION_COLOUR, about (34, 117, 60): green 70 above red and blue's mean.
          const hoverImg = await grab(page);
          if (MEASURE) console.log(`hovered ${await page.evaluate(() => document.querySelector("#viewport").dataset.hover)}\n  ${say(probe(hoverImg, ...front, ts))}`);
          const hovered = greenest(probe(hoverImg, ...front, ts));
          assert.ok(hovered > 35, `the hovered front edge is drawn in the hover tint, not under the sketch line (green ${hovered})`);
          await page.mouse.click(cx, cy);
        } else await page.touchscreen.tap(cx, cy);
        await page.waitForFunction(() => /edges \d+$/.test(document.querySelector("#viewport").dataset.highlight ?? ""), null, { timeout: 5000 });
        // Picked: SELECTION_COLOUR, (64, 230, 115): green 140 above red and blue's mean.
        const pickedImg = await grab(page);
        if (shots) await page.locator("#viewport canvas").screenshot({ path: `${shots}/hidden-edges-picked-${width}.png` });
        if (MEASURE) console.log(`picked ${await page.evaluate(() => document.querySelector("#viewport").dataset.highlight)}\n  ${say(probe(pickedImg, ...front, ts))}`);
        const picked = greenest(probe(pickedImg, ...front, ts));
        assert.ok(picked > 90, `the picked front edge is drawn in the selection green, not under the sketch line (green ${picked})`);
      } finally {
        await page.context().close();
      }
    });
} finally {
  await browser.close();
  server.httpServer.close();
}
if (errors.length) {
  console.log(`FAIL page errors:\n  ${errors.join("\n  ")}`);
  failed = true;
}
console.log(failed ? `hidden-edges: FAILED (${browserName})` : `hidden-edges: all passed (${browserName})`);
process.exit(failed ? 1 : 0);
