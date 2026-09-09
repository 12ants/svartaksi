/**
 * Retaining walls and portal faces for roads the elevation profile digs below grade.
 *
 * A tunnel's own carriageway is never drawn (see `surfaceVisibility`), but the approach
 * ramps that carry the street down to it are ordinary visible roads, and the profile digs
 * them. The ground, meanwhile, is a solid plane at grade. So a road descending toward a
 * portal drove straight into that plane: the ribbon disappeared inside the ground it was
 * supposedly cut into, and the car sank with it.
 *
 * This is the mirror of what `deckThicknessProfile` and the deck walls do for a road that
 * rises. Where a deck grows a slab downward from its surface, a cutting grows walls upward
 * from its surface to the grade it was dug out of, and caps the mouth where the visible
 * road hands over to the tunnel nothing paints.
 *
 * Placement is pure arithmetic over the road's own samples — the same extended polyline
 * and profile heights the carriageway was built from — so a wall cannot part company with
 * the road it retains. Only `buildTunnelTrenchGeometry` touches three.js.
 */
import * as THREE from 'three';
import { roadRibbonFrames } from './roadRibbon';
import type { LocalPoint } from './types';

/**
 * Depth below the road's own at-grade baseline at which a dip becomes a cutting, in
 * metres.
 *
 * Below this a road is merely following ground that sags — a dip under a railway, a
 * kerbed hollow — and walling it would put concrete along every gentle depression in the
 * city. At this depth the road is unambiguously *in* something it was dug out of, and the
 * ground plane is already cutting the ribbon off.
 *
 * Deliberately smaller than the deck side's `ROAD_DECK_LIFT` (1.5m): a wall becomes
 * necessary as soon as the ground plane starts to swallow the road, which happens far
 * sooner than a deck needs a slab.
 */
const MIN_TRENCH_DEPTH = 0.35;

/**
 * How far the wall's top edge is raised above the grade it retains, in metres.
 *
 * The wall has to *reach* the ground plane, not stop level with it: the plane is a
 * tessellated surface with its own slight variation, and a wall ending exactly at the
 * nominal baseline leaves a hairline of daylight between the two wherever the ground sits
 * a millimetre high. A small overshoot buries the seam in the ground instead.
 */
const TRENCH_WALL_OVERSHOOT = 0.25;

/** Metres the wall stands out from the paved edge, so the carriageway keeps its full
 * width and the wall does not eat the lane it retains. */
const TRENCH_WALL_OUTSET = 0.15;

/** Half-thickness of a wall, in metres. Thin: it is a retaining face, and only ever seen
 * from the road side or from directly above. */
const TRENCH_WALL_HALF = 0.25;

/**
 * The stretches of a road deep enough below grade to need retaining, as runs of
 * consecutive samples.
 *
 * Returned as runs rather than a flat mask because both ends of a run matter: a run that
 * stops mid-polyline has come back up to grade and wants no cap, while a run reaching the
 * road's own end while still deep is a mouth handing over to the tunnel, and wants one.
 */
export function trenchRuns(
  points: readonly LocalPoint[],
  lifts: readonly number[],
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  for (let index = 0; index < points.length; index += 1) {
    const deep = -(lifts[index] ?? 0) >= MIN_TRENCH_DEPTH;
    if (deep && start === null) start = index;
    else if (!deep && start !== null) {
      if (index - 1 > start) runs.push({ start, end: index - 1 });
      start = null;
    }
  }
  if (start !== null && points.length - 1 > start) runs.push({ start, end: points.length - 1 });
  return runs;
}

interface WallVertexSink {
  positions: number[];
  indices: number[];
}

/** Appends one quad, wound so its face points along `+normal` rather than into the cut. */
function pushQuad(
  sink: WallVertexSink,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  const base = sink.positions.length / 3;
  for (const vertex of [a, b, c, d]) sink.positions.push(vertex[0], vertex[1], vertex[2]);
  sink.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Retaining-wall and portal geometry for one road, or `null` where the road is never dug
 * deep enough to need any.
 *
 * `points`/`elevations`/`lifts` are the road's extended polyline and its profile heights —
 * the arrays `roadDeckSamples` produced and the carriageway was built from, passed in
 * rather than recomputed.
 *
 * Each wall is a closed slab rather than a single-sided plane: a plane is invisible from
 * behind under a FrontSide material, and the top of a cutting is seen from above as often
 * as the face of it is seen from the road.
 */
export function buildTunnelTrenchGeometry(
  points: readonly LocalPoint[],
  elevations: readonly number[],
  lifts: readonly number[],
  width: number,
): THREE.BufferGeometry | null {
  if (points.length < 2 || width <= 0) return null;
  const runs = trenchRuns(points, lifts);
  if (!runs.length) return null;

  const frames = roadRibbonFrames(points, width);
  const half = width / 2;
  // Scaling the offset keeps the miter stretch that holds the wall on the road's edge
  // through a bend; adding a constant to the vector's length would lose it exactly there.
  //
  // The wall sits wholly *outside* the paved edge: its inner face starts at the edge plus
  // the outset, and its thickness is added beyond that. Growing it inward instead would
  // retain the cutting by eating the lane it exists to keep drivable.
  const innerScale = (half + TRENCH_WALL_OUTSET) / half;
  const outsetScale = (half + TRENCH_WALL_OUTSET + 2 * TRENCH_WALL_HALF) / half;

  const sink: WallVertexSink = { positions: [], indices: [] };
  const gradeAt = (index: number) => elevations[index] - lifts[index] + TRENCH_WALL_OVERSHOOT;

  for (const run of runs) {
    for (const side of [1, -1] as const) {
      // Outer and inner faces of the wall on this side, at each sample of the run.
      const outer = (index: number): [number, number] => [
        points[index].x + frames[index].offsetX * outsetScale * side,
        points[index].z + frames[index].offsetZ * outsetScale * side,
      ];
      const inner = (index: number): [number, number] => [
        points[index].x + frames[index].offsetX * innerScale * side,
        points[index].z + frames[index].offsetZ * innerScale * side,
      ];

      for (let index = run.start; index < run.end; index += 1) {
        const next = index + 1;
        const [ox0, oz0] = outer(index);
        const [ox1, oz1] = outer(next);
        const [ix0, iz0] = inner(index);
        const [ix1, iz1] = inner(next);
        const foot0 = elevations[index];
        const foot1 = elevations[next];
        const top0 = gradeAt(index);
        const top1 = gradeAt(next);

        // Inner face, looking across the carriageway — the one actually seen from a car
        // in the cut. Wound so it faces inward, toward the road.
        pushQuad(sink,
          [ix0, foot0, iz0], [ix1, foot1, iz1], [ix1, top1, iz1], [ix0, top0, iz0]);
        // Outer face, seen where the ground falls away beside the cut.
        pushQuad(sink,
          [ox0, top0, oz0], [ox1, top1, oz1], [ox1, foot1, oz1], [ox0, foot0, oz0]);
        // Cap along the top, which is what a pedestrian standing at the edge looks down at.
        pushQuad(sink,
          [ix0, top0, iz0], [ix1, top1, iz1], [ox1, top1, oz1], [ox0, top0, oz0]);
      }

      // End caps, so the wall is a closed solid rather than an open shell seen edge-on.
      for (const [index, facingForward] of [[run.start, false], [run.end, true]] as const) {
        const [ox, oz] = outer(index);
        const [ix, iz] = inner(index);
        const foot = elevations[index];
        const top = gradeAt(index);
        const quad: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] =
          [[ix, foot, iz], [ox, foot, oz], [ox, top, oz], [ix, top, iz]];
        pushQuad(sink, ...(facingForward ? quad : [quad[3], quad[2], quad[1], quad[0]] as typeof quad));
      }
    }

    // The portal: a face across the full width where a cutting reaches the road's own end
    // while still deep. That is the mouth — the visible road stops here and hands over to
    // a tunnel nothing paints — and without it you look straight into the open end of the
    // cut and out the far side of the world.
    //
    // A run that ends mid-polyline has climbed back to grade under its own steam and gets
    // no portal: there is no tunnel there, just road.
    for (const [index, isTail] of [[run.start, false], [run.end, true]] as const) {
      const atRoadEnd = isTail ? index === points.length - 1 : index === 0;
      if (!atRoadEnd) continue;
      const [lx, lz] = [
        points[index].x + frames[index].offsetX * outsetScale,
        points[index].z + frames[index].offsetZ * outsetScale,
      ];
      const [rx, rz] = [
        points[index].x - frames[index].offsetX * outsetScale,
        points[index].z - frames[index].offsetZ * outsetScale,
      ];
      const foot = elevations[index];
      const top = gradeAt(index);
      const quad: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] =
        [[lx, foot, lz], [rx, foot, rz], [rx, top, rz], [lx, top, lz]];
      pushQuad(sink, ...(isTail ? quad : [quad[3], quad[2], quad[1], quad[0]] as typeof quad));
    }
  }

  if (!sink.indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(sink.positions, 3));
  geometry.setIndex(sink.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Poured retaining concrete — darker and slightly damper-looking than the piers that
 * stand in open air, which is what the inside of a cutting reads as. Shared for the
 * world's lifetime rather than rebuilt per snapshot. */
export function createTrenchMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x6f6d69, roughness: 0.95, metalness: 0.02 });
}
