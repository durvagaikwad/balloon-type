import * as THREE from "three";

/*
 * Glyph -> signed distance field (SDF) on the CPU.
 *
 * Each letter is drawn to a canvas tile, converted to an exact Euclidean SDF,
 * rounded (morphological open + close) and lightly blurred. The fields are
 * packed into one half-float atlas for the shader, and a low-res copy plus an
 * outline is kept on the CPU for shape-accurate collisions and layout.
 */

export const SDF_RESOLUTION = 512; // per-letter tile size (texels)
const SDF_PADDING = 0.14; // empty margin around the glyph inside its tile
const INF = 1e20;

// 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher),
// applied in place along one row or column of `grid`.
function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Uint16Array,
  z: Float64Array,
) {
  for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride];
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1, k = 0; q < length; q++) {
    let s: number;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    grid[offset + q * stride] = f[r] + (q - r) * (q - r);
  }
}

function edt2d(grid: Float64Array, size: number) {
  const f = new Float64Array(size);
  const v = new Uint16Array(size);
  const z = new Float64Array(size + 1);
  for (let x = 0; x < size; x++) edt1d(grid, x, size, size, f, v, z);
  for (let y = 0; y < size; y++) edt1d(grid, y * size, 1, size, f, v, z);
}

// Coverage (0..1, square grid) -> signed distance in texels, negative inside.
// Partial coverage gives sub-texel edge accuracy.
function sdfFromCoverage(a: Float32Array, size: number): Float32Array {
  const outer = new Float64Array(size * size);
  const inner = new Float64Array(size * size);
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (c <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      outer[i] = Math.max(0, 0.5 - c) ** 2;
      inner[i] = Math.max(0, c - 0.5) ** 2;
    }
  }
  edt2d(outer, size);
  edt2d(inner, size);
  const d = new Float32Array(size * size);
  for (let i = 0; i < d.length; i++) d[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
  return d;
}

// Re-threshold a distance field at `offset` and rebuild it (erode > 0, dilate < 0).
function offsetSdf(d: Float32Array, size: number, offset: number): Float32Array {
  const a = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) a[i] = Math.min(1, Math.max(0, 0.5 - (d[i] + offset)));
  return sdfFromCoverage(a, size);
}

// Separable box blur, run twice (≈ gaussian). Removes the EDT's stair-steps,
// which the steep balloon edge would otherwise magnify into streaks in the gloss.
function blurSdf(d: Float32Array, size: number, radius: number): Float32Array {
  let src = d.slice();
  let dst = new Float32Array(d.length);
  const w = 2 * radius + 1;
  for (let pass = 0; pass < 4; pass++) {
    const horizontal = pass % 2 === 0;
    for (let line = 0; line < size; line++) {
      const at = (i: number) => {
        const c = Math.min(size - 1, Math.max(0, i));
        return horizontal ? src[line * size + c] : src[c * size + line];
      };
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += at(i);
      for (let i = 0; i < size; i++) {
        const idx = horizontal ? line * size + i : i * size + line;
        dst[idx] = sum / w;
        sum += at(i + radius + 1) - at(i - radius);
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/* ───────────── Collision shapes ───────────── */

/** Low-res CPU copy of a letter's SDF plus points along its outline. */
export type Shape = {
  field: Float32Array; // COLLISION_RES², tile units, row 0 = bottom (uv.y up, same as the shader)
  outline: Float32Array; // [u, v, u, v, ...] in tile uv
};

const COLLISION_RES = 96;
const OUTLINE_POINTS = 72;

function buildShape(d: Float32Array, S: number): Shape {
  const R = COLLISION_RES;
  const field = new Float32Array(R * R);
  for (let r = 0; r < R; r++) {
    const srcRow = S - 1 - Math.round((r * (S - 1)) / (R - 1));
    for (let c = 0; c < R; c++) {
      field[r * R + c] = d[srcRow * S + Math.round((c * (S - 1)) / (R - 1))] / S;
    }
  }
  // Outline: every cell where the sign flips, snapped onto the zero crossing.
  const pts: number[] = [];
  const step = 1 / (R - 1);
  for (let r = 1; r < R - 1; r++) {
    for (let c = 1; c < R - 1; c++) {
      const f = field[r * R + c];
      const flipsRight = Math.sign(f) !== Math.sign(field[r * R + c + 1]);
      const flipsUp = Math.sign(f) !== Math.sign(field[(r + 1) * R + c]);
      if (!flipsRight && !flipsUp) continue;
      const gx = (field[r * R + c + 1] - field[r * R + c - 1]) / (2 * step);
      const gy = (field[(r + 1) * R + c] - field[(r - 1) * R + c]) / (2 * step);
      const g2 = gx * gx + gy * gy || 1;
      pts.push(c * step - (f * gx) / g2, r * step - (f * gy) / g2);
    }
  }
  const count = pts.length / 2;
  const keep = Math.min(OUTLINE_POINTS, count);
  const outline = new Float32Array(keep * 2);
  for (let k = 0; k < keep; k++) {
    const src = Math.floor((k * count) / keep) * 2;
    outline[k * 2] = pts[src];
    outline[k * 2 + 1] = pts[src + 1];
  }
  return { field, outline };
}

/** Signed distance (tile units) at tile uv, bilinear; outside the tile, adds the distance to it. */
export function sampleShape(field: Float32Array, u: number, v: number): number {
  const R = COLLISION_RES;
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));
  const x = cu * (R - 1);
  const y = cv * (R - 1);
  const x0 = Math.min(R - 2, Math.floor(x));
  const y0 = Math.min(R - 2, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * R + x0;
  const top = field[i] + (field[i + 1] - field[i]) * tx;
  const bottom = field[i + R] + (field[i + R + 1] - field[i + R]) * tx;
  return top + (bottom - top) * ty + Math.hypot(u - cu, v - cv);
}

/** Where a letter sits: center, rotation (ccw, matching the shader) and tile size. */
export type Pose = { cx: number; cy: number; cos: number; sin: number; tile: number };

/**
 * Deepest point of A's outline that comes within `gap` of B. Returns the
 * penetration depth and B's outward normal there (push A along it, B against it).
 */
export function deepestContact(a: Pose, shapeA: Shape, b: Pose, shapeB: Shape, gap: number) {
  let pen = 0;
  let nx = 0;
  let ny = 0;
  const o = shapeA.outline;
  const e = 1 / (COLLISION_RES - 1);
  for (let k = 0; k < o.length; k += 2) {
    const lx = (o[k] - 0.5) * a.tile;
    const ly = (o[k + 1] - 0.5) * a.tile;
    const wx = a.cx + a.cos * lx - a.sin * ly - b.cx;
    const wy = a.cy + a.sin * lx + a.cos * ly - b.cy;
    const u = (b.cos * wx + b.sin * wy) / b.tile + 0.5;
    const v = (-b.sin * wx + b.cos * wy) / b.tile + 0.5;
    if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) continue;
    const p = gap - sampleShape(shapeB.field, u, v) * b.tile;
    if (p <= pen) continue;
    const gu = sampleShape(shapeB.field, u + e, v) - sampleShape(shapeB.field, u - e, v);
    const gv = sampleShape(shapeB.field, u, v + e) - sampleShape(shapeB.field, u, v - e);
    const gx = b.cos * gu - b.sin * gv;
    const gy = b.sin * gu + b.cos * gv;
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-9) continue;
    pen = p;
    nx = gx / gl;
    ny = gy / gl;
  }
  return { pen, nx, ny };
}

/** True if the two letters come within `gap` of each other anywhere. */
export function shapesTouch(a: Pose, shapeA: Shape, b: Pose, shapeB: Shape, gap: number) {
  if (Math.hypot(b.cx - a.cx, b.cy - a.cy) > 0.55 * (a.tile + b.tile) + gap) return false;
  return (
    deepestContact(a, shapeA, b, shapeB, gap).pen > 0 ||
    deepestContact(b, shapeB, a, shapeA, gap).pen > 0
  );
}

/** World-space bounding box of a letter's outline. */
export function outlineBounds(pose: Pose, shape: Shape) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const o = shape.outline;
  for (let k = 0; k < o.length; k += 2) {
    const lx = (o[k] - 0.5) * pose.tile;
    const ly = (o[k + 1] - 0.5) * pose.tile;
    const wx = pose.cx + pose.cos * lx - pose.sin * ly;
    const wy = pose.cy + pose.sin * lx + pose.cos * ly;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  return { minX, maxX, minY, maxY };
}

/* ───────────── Atlas ───────────── */

export type Atlas = {
  texture: THREE.DataTexture;
  cols: number;
  rows: number;
  /** Ink height of each glyph as a fraction of its tile. */
  inkHeights: number[];
  /** Ink width / height of each glyph. */
  inkAspects: number[];
  shapes: Shape[];
};

/** True if the font draws any ink for this character (spaces, missing glyphs -> false). */
export function hasInk(ctx: CanvasRenderingContext2D, char: string) {
  const m = ctx.measureText(char);
  return (
    m.actualBoundingBoxLeft + m.actualBoundingBoxRight > 0.5 &&
    m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0.5
  );
}

export function buildAtlas(chars: string[], font: (px: number) => string, rounding: number): Atlas {
  const S = SDF_RESOLUTION;
  // Tiles are packed in a grid (not one long strip) to stay under mobile texture size limits.
  const cols = Math.max(1, Math.ceil(Math.sqrt(chars.length)));
  const rows = Math.max(1, Math.ceil(chars.length / cols));
  const rowStride = S * cols;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = new Uint16Array(rowStride * S * rows);
  const inkHeights: number[] = [];
  const inkAspects: number[] = [];
  const shapes: Shape[] = [];
  const r = rounding * S;

  chars.forEach((char, li) => {
    // Fit the glyph's ink box inside the tile.
    const probe = 100;
    ctx.font = font(probe);
    const m = ctx.measureText(char);
    const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const k = (S * (1 - 2 * SDF_PADDING)) / Math.max(inkW, inkH);

    ctx.clearRect(0, 0, S, S);
    ctx.font = font(probe * k);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "alphabetic";
    const x = S / 2 - ((m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2) * k;
    const y = S / 2 + ((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2) * k;
    ctx.fillText(char, x, y);
    inkHeights.push((inkH * k) / S);
    inkAspects.push(inkW / inkH);

    const px = ctx.getImageData(0, 0, S, S).data;
    const cov = new Float32Array(S * S);
    for (let i = 0; i < cov.length; i++) cov[i] = px[i * 4 + 3] / 255;

    let d = sdfFromCoverage(cov, S);
    if (r > 0) {
      d = offsetSdf(d, S, r); // erode
      for (let i = 0; i < d.length; i++) d[i] -= r; // dilate back: rounds convex corners
      d = offsetSdf(d, S, -r); // dilate
      for (let i = 0; i < d.length; i++) d[i] += r; // erode back: rounds concave corners
    }
    d = blurSdf(d, S, 2);
    shapes.push(buildShape(d, S));

    // Write into the atlas in tile units, flipping rows so uv.y points up.
    const tileX = (li % cols) * S;
    const tileY = Math.floor(li / cols) * S;
    for (let row = 0; row < S; row++) {
      const src = (S - 1 - row) * S;
      const dst = (tileY + row) * rowStride + tileX;
      for (let col = 0; col < S; col++) data[dst + col] = THREE.DataUtils.toHalfFloat(d[src + col] / S);
    }
  });

  const texture = new THREE.DataTexture(data, rowStride, S * rows, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, cols, rows, inkHeights, inkAspects, shapes };
}
