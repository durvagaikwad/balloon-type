import { outlineBounds, shapesTouch, type Atlas, type Pose } from "./sdf";

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
