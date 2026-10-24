// Where sketch points are on screen, for the browser tests that click in
// a sketch or look at its pixels: the camera sums the viewport uses (45°
// field of view, fitted at r / sin(half the field of view)), worked out
// here on their own, so a test can say "click (40, 30)" in sketch
// millimetres. The default part is the 40 × 30 × 20 box from (0, 0, 0).

/** The view framing the box: about its centre, radius half its diagonal. */
export const HOME = { toward: [0.6, -0.8, 0.55], up: [0, 0, 1], centre: [20, 15, 10], radius: Math.sqrt(2900) / 2 };
/** Straight down, as a sketch on the ground plane is looked at. */
export const TOP = { ...HOME, toward: [0, 0, 1], up: [0, 1, 0] };
/**
 * Straight down on a sketch started in an empty design (U0c): nothing to
 * frame, so Look At frames 50 mm round the plane's origin
 * (packages/viewport framing.ts LOOK_AT_EMPTY_RADIUS).
 */
export const EMPTY_TOP = { toward: [0, 0, 1], up: [0, 1, 0], centre: [0, 0, 0], radius: 50 };

/** Where a model point is on screen, for a canvas at `box` and a view framing the box. */
export function screenPoint(box, [px, py, pz], view) {
  const n = Math.hypot(...view.toward);
  const dir = view.toward.map((d) => d / n);
  const aspect = box.width / box.height;
  const half = aspect < 1 ? Math.atan(Math.tan(Math.PI / 8) * aspect) : Math.PI / 8;
  const dist = view.radius / Math.sin(half);
  const cam = view.centre.map((c, i) => c + dir[i] * dist);
  const fwd = dir.map((d) => -d);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  const right = unit(cross(fwd, view.up));
  const up = cross(right, fwd);
  const v = [px - cam[0], py - cam[1], pz - cam[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const t = Math.tan(Math.PI / 8);
  const ndcX = dot(v, right) / (dot(v, fwd) * t * aspect);
  const ndcY = dot(v, up) / (dot(v, fwd) * t);
  return { x: box.x + ((ndcX + 1) / 2) * box.width, y: box.y + ((1 - ndcY) / 2) * box.height };
}

/**
 * Clicks (or taps) at a point of the ground plane, z = 0, as seen from
 * `view`. Fails if something else is on top of the canvas there (the view
 * cube, a panel), so a test never clicks it by accident.
 */
export async function clickPlane(page, [x, y], view = TOP, tap = false) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const p = screenPoint(box, [x, y, 0], view);
  const on = await page.evaluate(([px, py]) => {
    const e = document.elementFromPoint(px, py);
    return e?.tagName === "CANVAS" && e.closest("#viewport") ? "canvas" : e ? e.id || e.className || e.tagName : "nothing";
  }, [p.x, p.y]);
  if (on !== "canvas") throw new Error(`(${x}, ${y}) is under ${on} on screen, not the canvas`);
  if (tap) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}
