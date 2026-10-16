// The flat sheet an image is drawn on (G1b), and the top-down camera that
// frames it. Pure maths, so it is tested without a browser; viewer.ts turns
// it into Three.js objects.

/** The sheet's four corners, their texture coordinates and its two triangles. */
export interface ImageSheet {
  widthMm: number;
  heightMm: number;
  /** Top-left, top-right, bottom-right, bottom-left; z = 0. */
  positions: Float32Array;
  /**
   * Texture coordinates per corner. Image rows run from the top and the
   * texture is uploaded unflipped, so row 0 sits at v = 0: the top corners
   * take v = 0 and the bottom ones v = 1.
   */
  uvs: Float32Array;
  /** Counter-clockwise seen from +Z, so the sheet faces the top-down camera. */
  indices: number[];
}

/**
 * The sheet for an image of `width` × `height` pixels, each `mmPerPixel`
 * across: centred on the origin in the XY plane, its top edge towards +Y.
 */
export function imageSheet(width: number, height: number, mmPerPixel: number): ImageSheet {
  const widthMm = width * mmPerPixel;
  const heightMm = height * mmPerPixel;
  const x = widthMm / 2;
  const y = heightMm / 2;
  return {
    widthMm,
    heightMm,
    positions: new Float32Array([-x, y, 0, x, y, 0, x, -y, 0, -x, -y, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    // 0 → 3 → 2 runs top-left, bottom-left, bottom-right: counter-clockwise from above.
    indices: [0, 3, 2, 0, 2, 1],
  };
}

/** Margin around a framed sheet: it fills 1 / SHEET_MARGIN of the narrower direction. */
export const SHEET_MARGIN = 1.1;

/**
 * How far above the sheet's centre a camera looking straight down must sit
 * for the whole sheet, with the margin, to fit: the half-height it must see
 * is the larger of half the sheet's height and half its width divided by the
 * aspect (width / height of the canvas), and a camera with vertical field
 * of view `fovDeg` sees half-height d·tan(fov / 2) at distance d.
 */
export function topDownDistance(widthMm: number, heightMm: number, fovDeg: number, aspect: number): number {
  const half = Math.max(heightMm / 2, widthMm / 2 / aspect) * SHEET_MARGIN;
  return half / Math.tan((fovDeg * Math.PI) / 360);
}

/** How near and far the camera may zoom, relative to the framing distance. */
export const ZOOM_IN = 1000;
export const ZOOM_OUT = 20;

/**
 * Zoom limits and clip planes for a sheet framed from `distance`: zooming in
 * stops at 1/ZOOM_IN of it (a 1000 × 1000 image then shows one pixel across
 * most of the view) and out at ZOOM_OUT times; the near and far planes sit
 * ten times beyond those, so the flat sheet is never clipped.
 */
export function imageZoomRange(distance: number): { minDistance: number; maxDistance: number; near: number; far: number } {
  const minDistance = distance / ZOOM_IN;
  const maxDistance = distance * ZOOM_OUT;
  return { minDistance, maxDistance, near: minDistance / 10, far: maxDistance * 10 };
}

/** Refuses an image larger than the graphics card's biggest texture, with a message a user can read. */
export function checkTextureSize(width: number, height: number, maxTextureSize: number): void {
  if (width > maxTextureSize || height > maxTextureSize) {
    throw new Error(`This image is ${width} × ${height} pixels, but this screen's graphics can show at most ${maxTextureSize} pixels along a side.`);
  }
}
