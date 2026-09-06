/**
 * The mitered edge frame a road ribbon is built from, shared by everything that has to
 * sit exactly on a road's edge.
 *
 * Pure geometry, no three.js — the carriageway (`threeWorld.ts`'s `buildRoadGeometry`),
 * the deck walls it extrudes, and the bridge railings (`bridgeRailings.ts`) all read the
 * same frame, so a railing cannot drift off the deck it is bolted to at a bend, which is
 * exactly where a second, independently-derived offset would part company with it.
 */
import type { LocalPoint } from './types';

/**
 * One point's place on the road ribbon: the mitered across-direction and the offset that
 * direction turns into at this road's own width.
 *
 * The two are not the same vector. `normalX/normalZ` is a unit bisector — a *direction*,
 * which is what the camber shading wants — while the offset carries the miter stretch that
 * keeps the ribbon's true width through a bend. Anything that has to sit on a road's edge
 * (the deck walls, the railings, a deck-mounted lamp) has to use the same offsets the
 * carriageway itself was built from, or it drifts off the pavement exactly where the road
 * bends, which is where it is most visible.
 */
export interface RoadRibbonFrame {
  normalX: number;
  normalZ: number;
  offsetX: number;
  offsetZ: number;
}

/**
 * The mitered edge frame for a whole polyline: each interior point gets the bisector of
 * its two adjacent segment normals, stretched to keep the road's true width across the
 * bend, so consecutive segments share exact edge vertices and the road reads as one
 * cohesive line instead of a chain of slightly gapped/overlapping slabs at every corner.
 */
export function roadRibbonFrames(points: readonly LocalPoint[], width: number): RoadRibbonFrame[] {
  const half = width / 2;
  const frames: RoadRibbonFrame[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const curr = points[index];
    let normalX: number;
    let normalZ: number;
    let miterScale = 1;

    if (index === 0 || index === points.length - 1) {
      const other = index === 0 ? points[1] : points[index - 1];
      const dx = index === 0 ? other.x - curr.x : curr.x - other.x;
      const dz = index === 0 ? other.z - curr.z : curr.z - other.z;
      const length = Math.hypot(dx, dz) || 1;
      normalX = -dz / length;
      normalZ = dx / length;
    } else {
      const prev = points[index - 1];
      const next = points[index + 1];
      const inLength = Math.hypot(curr.x - prev.x, curr.z - prev.z) || 1;
      const inX = -(curr.z - prev.z) / inLength;
      const inZ = (curr.x - prev.x) / inLength;
      const outLength = Math.hypot(next.x - curr.x, next.z - curr.z) || 1;
      const outX = -(next.z - curr.z) / outLength;
      const outZ = (next.x - curr.x) / outLength;
      let sumX = inX + outX;
      let sumZ = inZ + outZ;
      const sumLength = Math.hypot(sumX, sumZ);
      if (sumLength < 1e-6) { sumX = inX; sumZ = inZ; } else { sumX /= sumLength; sumZ /= sumLength; }
      normalX = sumX;
      normalZ = sumZ;
      // Miter length grows as the bend sharpens (bisector no longer aligns with
      // either segment normal); clamped so hairpin turns don't spike outward.
      const alignment = normalX * inX + normalZ * inZ;
      miterScale = Math.min(3, 1 / Math.max(0.35, alignment));
    }

    frames.push({
      normalX,
      normalZ,
      offsetX: normalX * half * miterScale,
      offsetZ: normalZ * half * miterScale,
    });
  }
  return frames;
}

const MIN_ROAD_ENDPOINT_EXTENSION = 0.5;

/** How far past its own mapped endpoint a road of this width is stretched — also the
 * length over which the shader dissolves that tip. */
export function roadEndpointExtension(width: number): number {
  return Math.max(MIN_ROAD_ENDPOINT_EXTENSION, width / 2);
}

/**
 * Adds one point past each end of a road's polyline, along the same tangent direction it
 * already had — each road is rendered as one independent ribbon (not stitched across ways
 * at intersections), so two ways that are supposed to meet at a shared junction node can
 * otherwise leave a hairline gap from tiny floating-point/data mismatches between them.
 * Extending by half the road's own width is enough that two same-width roads meeting at a
 * point fully overlap at the junction, without visibly lengthening the road elsewhere.
 *
 * The stub is *added*, not substituted for the mapped endpoint it grows from. Moving the
 * endpoint instead left the ribbon with no vertex at the point the road actually ends at,
 * and the tip-dissolve channel buildRoadGeometry writes is a vertex attribute: with the
 * endpoint gone, the value that should have marked "fully opaque from here inward" had
 * nowhere to sit, so the dissolve interpolated across the whole first and last *segment*
 * rather than across the stub. On the two-point polylines vector tiles are full of —
 * every straight run of road — both of the only vertices were tips, so the attribute read
 * 0 across the entire ribbon and the road rendered completely transparent. Keeping the
 * mapped endpoints also keeps elevation sampling exact there, which matters now that a
 * profile's own endpoint is where a deck hands over to its approach ramp.
 */
export function extendRoadEndpoints(points: LocalPoint[], width: number): LocalPoint[] {
  if (points.length < 2) return points;
  const extension = roadEndpointExtension(width);
  const extend = (from: LocalPoint, away: LocalPoint): LocalPoint => {
    const dx = from.x - away.x;
    const dz = from.z - away.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: from.x + (dx / length) * extension, z: from.z + (dz / length) * extension };
  };
  return [
    extend(points[0], points[1]),
    ...points,
    extend(points[points.length - 1], points[points.length - 2]),
  ];
}

