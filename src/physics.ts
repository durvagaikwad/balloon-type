import { deepestContact, outlineBounds, type Pose, type Shape } from "./sdf";

/** A letter's offset from its layout position (screen units) and extra tilt (rad), with velocities. */
export type Body = { x: number; y: number; vx: number; vy: number; a: number; va: number };

/** A letter's layout pose in screen units (component height = 1, origin at the center, y up). */
export type Rest = { x: number; y: number; angle: number; tile: number; mass: number };

const CONTACT_ITERATIONS = 4;

/**
 * Keeps letters from overlapping each other or leaving the view, using their
 * real shapes. Each iteration finds the deepest outline point of either letter
 * inside the other (closer than `gap`), separates the pair along the surface
 * normal there (split by mass) and bounces their closing velocity.
 */
export function resolveContacts(
  shapes: Shape[],
  bodies: Body[],
  rest: Rest[],
  gap: number,
  bounce: number,
  aspect: number,
) {
  const n = bodies.length;
  const poseOf = (i: number): Pose => {
    const angle = rest[i].angle + bodies[i].a;
    return {
      cx: rest[i].x + bodies[i].x,
      cy: rest[i].y + bodies[i].y,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      tile: rest[i].tile,
    };
  };

  for (let it = 0; it < CONTACT_ITERATIONS; it++) {
    const poses = bodies.map((_, i) => poseOf(i));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const pa = poses[i];
        const pb = poses[j];
        const reach = 0.55 * (pa.tile + pb.tile) + gap; // glyphs fit well inside their tiles
        if (Math.hypot(pb.cx - pa.cx, pb.cy - pa.cy) > reach) continue;

        const ij = deepestContact(pa, shapes[i], pb, shapes[j], gap);
        const ji = deepestContact(pb, shapes[j], pa, shapes[i], gap);
        // Normal points from j toward i.
        const pen = Math.max(ij.pen, ji.pen);
        if (pen <= 0) continue;
        const nx = ij.pen >= ji.pen ? ij.nx : -ji.nx;
        const ny = ij.pen >= ji.pen ? ij.ny : -ji.ny;

        const mi = rest[i].mass;
        const mj = rest[j].mass;
        const si = pen * (mj / (mi + mj));
        const sj = pen * (mi / (mi + mj));
        bodies[i].x += nx * si;
        bodies[i].y += ny * si;
        bodies[j].x -= nx * sj;
        bodies[j].y -= ny * sj;
        pa.cx += nx * si;
        pa.cy += ny * si;
        pb.cx -= nx * sj;
        pb.cy -= ny * sj;

        const vn = (bodies[i].vx - bodies[j].vx) * nx + (bodies[i].vy - bodies[j].vy) * ny;
        if (vn < 0) {
          const impulse = (-(1 + bounce) * vn) / (1 / mi + 1 / mj);
          bodies[i].vx += (impulse / mi) * nx;
          bodies[i].vy += (impulse / mi) * ny;
          bodies[j].vx -= (impulse / mj) * nx;
          bodies[j].vy -= (impulse / mj) * ny;
        }
      }
    }

    // Edges of the view, using the outline's actual extent.
    const halfW = aspect / 2;
    for (let i = 0; i < n; i++) {
      const { minX, maxX, minY, maxY } = outlineBounds(poses[i], shapes[i]);
      const b = bodies[i];
      if (maxX > halfW) {
        b.x -= maxX - halfW;
        if (b.vx > 0) b.vx *= -bounce;
      } else if (minX < -halfW) {
        b.x += -halfW - minX;
        if (b.vx < 0) b.vx *= -bounce;
      }
      if (maxY > 0.5) {
        b.y -= maxY - 0.5;
        if (b.vy > 0) b.vy *= -bounce;
      } else if (minY < -0.5) {
        b.y += -0.5 - minY;
        if (b.vy < 0) b.vy *= -bounce;
      }
    }
  }
}
