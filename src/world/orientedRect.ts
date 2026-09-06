/**
 * Minimum-area oriented bounding rectangle of a simple polygon, for turning a building
 * footprint into a single collision box.
 *
 * The classic result used here: the minimum-area enclosing rectangle of any convex
 * polygon has one side flush with an edge of the polygon's convex hull ("rotating
 * calipers" — O'Rourke 1985). So the search is: hull the ring, then for each hull edge,
 * measure the axis-aligned bounds of every hull point in that edge's own frame, and keep
 * whichever edge gives the smallest area. That is O(n^2) on the hull, not the linear
 * rotating-calipers walk, but building footprints are tens of points at most and this
 * runs once per building id (see buildingColliders.ts), not per frame.
 */
import type { LocalPoint } from './types';

export interface OrientedRect {
  /** Centre of the rectangle in the same xz frame as the input ring. */
  center: LocalPoint;
  /** Radians, the rotation of the rectangle's local x axis from world x. */
  angle: number;
  /** Half the rectangle's extent along its own rotated x axis. */
  halfWidth: number;
  /** Half the rectangle's extent along its own rotated z (perpendicular) axis. */
  halfDepth: number;
}

/** Signed area via the shoelace formula; magnitude is the polygon's area regardless of
 * winding. Used both to size rectangles and to score how well one fits a footprint. */
export function polygonArea(ring: readonly LocalPoint[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

/** Andrew's monotone chain. Returns hull points counter-clockwise, no repeated closing
 * point. Degenerate input (fewer than 3 distinct points) returns the input as-is. */
export function convexHull(points: readonly LocalPoint[]): LocalPoint[] {
  const unique: LocalPoint[] = [];
  const seen = new Set<string>();
  for (const p of points) {
    const key = `${p.x.toFixed(6)}:${p.z.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  if (unique.length < 3) return unique;
  const sorted = [...unique].sort((a, b) => (a.x - b.x) || (a.z - b.z));
  const cross = (o: LocalPoint, a: LocalPoint, b: LocalPoint) =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower: LocalPoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: LocalPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Minimum-area oriented rectangle enclosing `ring`'s convex hull. Falls back to an
 * axis-aligned box (angle 0) when the ring degenerates to fewer than 2 distinct points
 * after hulling, since no orientation is meaningful there.
 */
export function minAreaOrientedRect(ring: readonly LocalPoint[]): OrientedRect {
  const hull = convexHull(ring);
  if (hull.length < 2) {
    const only = ring[0] ?? { x: 0, z: 0 };
    return { center: { x: only.x, z: only.z }, angle: 0, halfWidth: 0.1, halfDepth: 0.1 };
  }
  if (hull.length === 2) {
    const [a, b] = hull;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const angle = Math.atan2(dz, dx);
    const length = Math.hypot(dx, dz);
    return {
      center: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
      angle,
      halfWidth: length / 2,
      halfDepth: 0.1,
    };
  }

  let best: OrientedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeAngle = Math.atan2(b.z - a.z, b.x - a.x);
    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * cos - p.z * sin;
      const v = p.x * sin + p.z * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const depth = maxV - minV;
    const area = width * depth;
    if (area < bestArea) {
      bestArea = area;
      const centerU = (minU + maxU) / 2;
      const centerV = (minV + maxV) / 2;
      const cosBack = Math.cos(edgeAngle);
      const sinBack = Math.sin(edgeAngle);
      best = {
        center: {
          x: centerU * cosBack - centerV * sinBack,
          z: centerU * sinBack + centerV * cosBack,
        },
        angle: edgeAngle,
        halfWidth: Math.max(width / 2, 0.05),
        halfDepth: Math.max(depth / 2, 0.05),
      };
    }
  }
  return best!;
}
