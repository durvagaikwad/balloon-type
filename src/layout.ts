import { resolveContacts, type Body, type Rest } from "./physics";
import { deepestContact, outlineBounds, shapesTouch, type Atlas, type Pose } from "./sdf";

/**
 * Where one letter sits, in layout units (any scale: the whole layout is
 * fitted to the component). y points up.
 */
export type LetterPlacement = {
  /** Center of the letter's ink. */
  x: number;
  y: number;
  /** Ink height. */
  height: number;
  /** Degrees, positive = clockwise. */
  rotate: number;
};

export type Token = { kind: "glyph"; index: number } | { kind: "space" } | { kind: "newline" };

export type FittedLayout = {
  /** Placements centered on (0, 0). */
  placements: LetterPlacement[];
  width: number;
  height: number;
};

export function poseOf(p: LetterPlacement, inkHeight: number): Pose {
  const a = (-p.rotate * Math.PI) / 180;
  return { cx: p.x, cy: p.y, cos: Math.cos(a), sin: Math.sin(a), tile: p.height / inkHeight };
}

/** Recenters placements on their real outline bounds and reports the size. */
export function fitLayout(placements: LetterPlacement[], atlas: Atlas): FittedLayout {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  placements.forEach((p, i) => {
    const b = outlineBounds(poseOf(p, atlas.inkHeights[i]), atlas.shapes[i]);
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY);
    maxY = Math.max(maxY, b.maxY);
  });
  if (!placements.length) return { placements, width: 1, height: 1 };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    placements: placements.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy })),
    width: maxX - minX,
    height: maxY - minY,
  };
}

// Small, fast, seedable PRNG so a given seed always gives the same layout.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = { L: 1, M: 0.66, S: 0.42 } as const;
type SizeClass = keyof typeof SIZE;

/**
 * Playful poster layout: big, medium and small letters with random tilts,
 * packed so small letters tuck into the gaps of big ones while reading order
 * is kept. Deterministic for a given seed.
 *
 * Each letter starts well to the right of the line and slides left until its
 * real outline comes within `gap` of a placed letter (or it would pass the
 * previous letter). Small and medium letters try sitting high, low and
 * centered and keep whichever slides furthest. Lines are then stacked by
 * sliding each one up until it touches the line above.
 */
export function autoLayout(
  tokens: Token[],
  atlas: Atlas,
  { seed, gap, sizeVariety, tilt }: { seed: number; gap: number; sizeVariety: number; tilt: number },
): LetterPlacement[] {
  const rand = mulberry32(seed);
  const out: LetterPlacement[] = [];
  const touches = (p: LetterPlacement, i: number, others: number[]) =>
    others.some((j) =>
      shapesTouch(
        poseOf(p, atlas.inkHeights[i]),
        atlas.shapes[i],
        poseOf(out[j], atlas.inkHeights[j]),
        atlas.shapes[j],
        gap,
      ),
    );

  // Slides `make(t)` from `from` toward `to` and returns the furthest position
  // that doesn't touch anything (binary-refined at the first contact).
  const slide = (make: (t: number) => LetterPlacement, i: number, others: number[], from: number, to: number) => {
    const dir = Math.sign(to - from) || 1;
    const step = 0.02 * dir;
    let free = from;
    for (let t = from + step; (to - t) * dir > 0; t += step) {
      if (touches(make(t), i, others)) {
        let lo = free;
        let hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          if (touches(make(mid), i, others)) hi = mid;
          else lo = mid;
        }
        return lo;
      }
      free = t;
    }
    return to;
  };

  // Split into lines of words.
  const lines: number[][][] = [[[]]];
  for (const tok of tokens) {
    const line = lines[lines.length - 1];
    if (tok.kind === "newline") lines.push([[]]);
    else if (tok.kind === "space") line.push([]);
    else line[line.length - 1].push(tok.index);
  }

  const lineMembers: number[][] = [];
  for (const words of lines) {
    const members: number[] = [];
    let right = 0; // right edge of the line so far
    let minCenter = -Infinity; // reading order: next letter's center can't go left of this
    for (const word of words) {
      if (!word.length) continue;
      if (members.length) {
        right += 0.55; // word space
        minCenter = right;
      }
      let prev: SizeClass | null = null;
      word.forEach((gi, wi) => {
        // Size: words start big; never two smalls in a row; narrow glyphs (I, l, 1) aren't made small.
        let cls: SizeClass;
        const narrow = atlas.inkAspects[gi] < 0.45;
        if (wi === 0 || word.length === 1) cls = "L";
        else {
          const r = rand();
          cls = r < 0.4 ? "L" : r < 0.7 || prev === "S" || narrow ? "M" : "S";
        }
        prev = cls;
        const height = 1 - sizeVariety * (1 - SIZE[cls]);
        const rotate = (rand() * 2 - 1) * tilt;
        const room = (1 - height) / 2;
        const ys =
          cls === "L"
            ? [(rand() * 2 - 1) * 0.03]
            : rand() < 0.5
              ? [room, -room, 0]
              : [-room, room, 0];

        let best: LetterPlacement | null = null;
        for (const y of ys) {
          const make = (x: number) => ({ x, y, height, rotate });
          // Far enough right that the letter can't touch anything yet (glyphs fit within 0.55 tile of center).
          const start = right + (height / atlas.inkHeights[gi]) * 0.6 + gap * 2;
          const floor = minCenter + height * 0.15;
          const x = members.length ? slide(make, gi, members, start, Math.max(floor, start - 3)) : 0;
          if (!best || x < best.x - 1e-3) best = make(x);
        }
        out[gi] = best!;
        members.push(gi);
        minCenter = best!.x;
        right = Math.max(right, outlineBounds(poseOf(best!, atlas.inkHeights[gi]), atlas.shapes[gi]).maxX);
      });
    }
    lineMembers.push(members);
  }

  // Center each line horizontally, then stack lines, each sliding up into the one above.
  const placed: number[] = [];
  let floorY = 0;
  lineMembers.forEach((members, li) => {
    if (!members.length) return;
    const fitted = fitLayout(members.map((i) => out[i]), {
      ...atlas,
      inkHeights: members.map((i) => atlas.inkHeights[i]),
      shapes: members.map((i) => atlas.shapes[i]),
    });
    members.forEach((gi, k) => (out[gi] = fitted.placements[k]));
    if (li === 0 || !placed.length) {
      placed.push(...members);
      floorY = -fitted.height / 2;
      return;
    }
    const base = members.map((i) => out[i]);
    const at = (dy: number) => members.forEach((gi, k) => (out[gi] = { ...base[k], y: base[k].y + dy }));
    const start = floorY - fitted.height / 2 - gap * 2 - 0.05;
    const lineTouches = (dy: number) => {
      at(dy);
      return members.some((gi) => touches(out[gi], gi, placed));
    };
    // Slide up (same scheme as letters, but moving the whole line).
    let free = start;
    let dy = start;
    for (let t = start + 0.02; t < 0; t += 0.02) {
      if (lineTouches(t)) {
        let lo = free;
        let hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          if (lineTouches(mid)) hi = mid;
          else lo = mid;
        }
        dy = lo;
        break;
      }
      free = t;
      dy = t;
    }
    at(dy);
    placed.push(...members);
    floorY = Math.min(...members.map((gi) => outlineBounds(poseOf(out[gi], atlas.inkHeights[gi]), atlas.shapes[gi]).minY));
  });

  return out;
}

/**
 * Fills a box of the given aspect (height 1) with the letters, edge to edge.
 *
 * 1. Split the letters into rows that suit the box shape, breaking between
 *    words where possible, so the text still reads left-to-right, top-to-bottom.
 * 2. Scatter each letter around its spot in its row with a random size and tilt.
 * 3. Grow each letter on its own, pushing neighbours aside by their real
 *    shapes and keeping everything inside the box, until every letter is
 *    boxed in. Letters with room keep growing, so gaps get filled.
 *
 * Deterministic for a given seed and aspect.
 */
export function fillLayout(
  tokens: Token[],
  atlas: Atlas,
  {
    seed,
    gap,
    sizeVariety,
    tilt,
    aspect,
  }: { seed: number; gap: number; sizeVariety: number; tilt: number; aspect: number },
): LetterPlacement[] {
  const rand = mulberry32(seed);
  const n = atlas.shapes.length;

  // Reading order, with word boundaries and forced line breaks.
  const order: number[] = [];
  const wordStart = new Set<number>(); // positions in `order` where a new word begins
  const forcedBreak = new Set<number>(); // positions where the text has "\n"
  let pendingWord = false;
  let pendingBreak = false;
  for (const tok of tokens) {
    if (tok.kind === "space") pendingWord = true;
    else if (tok.kind === "newline") pendingBreak = true;
    else {
      if (order.length && (pendingWord || pendingBreak)) wordStart.add(order.length);
      if (order.length && pendingBreak) forcedBreak.add(order.length);
      pendingWord = pendingBreak = false;
      order.push(tok.index);
    }
  }

  // Rows: explicit line breaks win; otherwise pick a count that makes roughly
  // square cells for this box, and snap each break to a nearby word boundary.
  let breaks: number[];
  if (forcedBreak.size) breaks = [...forcedBreak].sort((a, b) => a - b);
  else {
    const rows = Math.min(n, Math.max(1, Math.round(Math.sqrt(n / aspect))));
    breaks = [];
    for (let r = 1; r < rows; r++) {
      const ideal = Math.round((r * n) / rows);
      const reach = Math.ceil(n / rows / 2);
      // Nearest word boundary within reach, else split the word at the ideal spot.
      let best = ideal;
      let bestDist = Infinity;
      for (const w of wordStart) {
        const d = Math.abs(w - ideal);
        if (d <= reach && d < bestDist) {
          best = w;
          bestDist = d;
        }
      }
      if (best > (breaks[breaks.length - 1] ?? 0) && best < n) breaks.push(best);
    }
  }
  const rowsOf: number[][] = [];
  let from = 0;
  for (const b of [...breaks, n]) {
    if (b > from) rowsOf.push(order.slice(from, b));
    from = b;
  }

  // Initial scatter: each letter near the center of its cell, small, with a random size and tilt.
  const R = rowsOf.length;
  const longest = Math.max(...rowsOf.map((r) => r.length));
  const start = 0.4 * Math.min(1 / R, aspect / longest);
  const pick = [1, 0.75, 0.55];
  const hgt: number[] = new Array(n); // ink heights
  const rot: number[] = new Array(n);
  const pos: { x: number; y: number }[] = new Array(n);
  rowsOf.forEach((row, r) => {
    const cellH = 1 / R;
    const cellW = aspect / row.length;
    row.forEach((gi, j) => {
      const r01 = rand();
      const cls = r01 < 0.45 ? pick[0] : r01 < 0.75 ? pick[1] : pick[2];
      hgt[gi] = start * (1 - sizeVariety * (1 - cls));
      rot[gi] = (rand() * 2 - 1) * tilt;
      pos[gi] = {
        x: -aspect / 2 + (j + 0.5) * cellW + (rand() - 0.5) * cellW * 0.3,
        y: 0.5 - (r + 0.5) * cellH + (rand() - 0.5) * cellH * 0.3,
      };
    });
  });

  // Reading order: each letter stays in its row's band (it can nest a little
  // into the next row) and to the right of the previous letter in its row.
  const keepOrder = () => {
    rowsOf.forEach((row, r) => {
      const center = 0.5 - (r + 0.5) / R;
      const band = 0.3 / R;
      row.forEach((gi, j) => {
        pos[gi].y = Math.min(center + band, Math.max(center - band, pos[gi].y));
        if (j === 0) return;
        const prev = row[j - 1];
        const minX = pos[prev].x + 0.25 * Math.min(hgt[prev], hgt[gi]);
        if (pos[gi].x < minX) pos[gi].x = minX;
      });
    });
  };

  const angle = (i: number) => (-rot[i] * Math.PI) / 180;
  const poses = (): Pose[] =>
    pos.map((p, i) => ({
      cx: p.x,
      cy: p.y,
      cos: Math.cos(angle(i)),
      sin: Math.sin(angle(i)),
      tile: hgt[i] / atlas.inkHeights[i],
    }));

  // Push letters apart and into the box (reuses the runtime contact solver).
  const relax = () => {
    for (let pass = 0; pass < 6; pass++) {
      const rest: Rest[] = pos.map((p, i) => ({
        x: p.x,
        y: p.y,
        angle: angle(i),
        tile: hgt[i] / atlas.inkHeights[i],
        mass: hgt[i],
      }));
      const bodies: Body[] = pos.map(() => ({ x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0 }));
      resolveContacts(atlas.shapes, bodies, rest, gap, 0, aspect);
      let moved = 0;
      bodies.forEach((b, i) => {
        pos[i] = { x: pos[i].x + b.x, y: pos[i].y + b.y };
        moved = Math.max(moved, Math.abs(b.x) + Math.abs(b.y));
      });
      keepOrder();
      if (moved < 1e-4) break;
    }
  };

  // Letters still overlapping a neighbour or poking out of the box.
  const tolerance = 0.002; // view heights
  const overlapping = () => {
    const ps = poses();
    const bad = new Set<number>();
    for (let i = 0; i < n; i++) {
      const b = outlineBounds(ps[i], atlas.shapes[i]);
      if (Math.max(b.maxX - aspect / 2, -aspect / 2 - b.minX, b.maxY - 0.5, -0.5 - b.minY) > tolerance) bad.add(i);
      for (let j = i + 1; j < n; j++) {
        if (Math.hypot(ps[j].cx - ps[i].cx, ps[j].cy - ps[i].cy) > 0.55 * (ps[i].tile + ps[j].tile) + gap) continue;
        const pen = Math.max(
          deepestContact(ps[i], atlas.shapes[i], ps[j], atlas.shapes[j], gap).pen,
          deepestContact(ps[j], atlas.shapes[j], ps[i], atlas.shapes[i], gap).pen,
        );
        if (pen > tolerance) {
          bad.add(i);
          bad.add(j);
        }
      }
    }
    return bad;
  };

  // Grow each letter on its own until it's boxed in. When a growth step
  // doesn't fit, undo it and halve the step of the growing letters involved;
  // a letter whose step gets tiny is done.
  relax();
  const step: number[] = new Array(n).fill(1.15);
  const done: boolean[] = new Array(n).fill(false);
  const MAX_HEIGHT = Math.min(0.92, 1.3 / R); // a letter can't swallow two rows
  for (let iter = 0; iter < 400 && done.includes(false); iter++) {
    const growing = done.flatMap((d, i) => (d ? [] : [i]));
    const prevH = hgt.slice();
    const prevPos = pos.map((p) => ({ ...p }));
    for (const i of growing) hgt[i] = Math.min(hgt[i] * step[i], MAX_HEIGHT);
    relax();
    const bad = overlapping();
    if (!bad.size) {
      for (const i of growing) if (hgt[i] >= MAX_HEIGHT) done[i] = true;
      continue;
    }
    prevH.forEach((h, i) => (hgt[i] = h));
    prevPos.forEach((p, i) => (pos[i] = p));
    const culprits = growing.filter((i) => bad.has(i));
    for (const i of culprits.length ? culprits : growing) {
      step[i] = 1 + (step[i] - 1) / 2;
      if (step[i] < 1.004) done[i] = true;
    }
  }

  return pos.map((p, i) => ({ x: p.x, y: p.y, height: hgt[i], rotate: rot[i] }));
}
