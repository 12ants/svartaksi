/**
 * Parapet railings for road decks: the posts and rails that stand along both edges of a
 * bridge and of the approach ramps carrying it back to street level.
 *
 * Placed off the same mitered ribbon frame the carriageway itself is built from
 * (`roadRibbon.ts`), and off the same `RoadElevationProfile` heights physics grounds a
 * vehicle on — so a railing is bolted to the deck rather than merely near it, at a bend
 * and on a ramp alike.
 *
 * Height is a function of how far the deck actually stands off its own baseline, not a
 * flag. A railing that switched on at a threshold would appear out of nowhere partway up
 * every approach; growing it out of the deck as the ramp climbs is what makes the
 * structure read as continuous from the street to the span and back.
 */
import * as THREE from 'three';
import { roadRibbonFrames } from './roadRibbon';
import { roadElevationAtPoint, type RoadElevationProfile } from './roadElevationProfile';
import type { LocalPoint, WorldRoad } from './types';

/** Height of the top rail above the deck surface, in meters — a shade over the 1.1m a
 * European road parapet is built to. */
const RAILING_HEIGHT = 1.15;

/** Deck lift at which a railing starts to show, and the lift at which it reaches full
 * height. Below the first there is nothing to fall off; by the second the deck is a
 * structure and wants a full parapet. Both are read against the road's own at-grade
 * baseline, the same quantity `ROAD_DECK_LIFT` is measured in. */
const RAILING_START_LIFT = 0.5;
const RAILING_FULL_LIFT = 1.6;

/** Below this the parapet is a kerb nobody would model, and its posts cost more triangles
 * than they buy. */
const MIN_RAILING_HEIGHT = 0.18;

/** Meters in from the paved edge the railing line sits, measured across the carriageway.
 * Far enough that a wheel is not inside the posts, close enough that the deck does not
 * grow a visible shoulder. */
const RAILING_INSET = 0.3;

/** Meters between posts. Real highway parapets run 2-3m; at the low end the railing still
 * reads as a railing rather than as a fence when seen from a car. */
const POST_SPACING = 2.4;

/** Half-thickness of a post and of each rail, in meters. */
const POST_HALF = 0.045;
const TOP_RAIL_HALF_WIDTH = 0.05;
const TOP_RAIL_HALF_HEIGHT = 0.055;
const MID_RAIL_HALF_WIDTH = 0.035;
const MID_RAIL_HALF_HEIGHT = 0.035;

/** How far a post is sunk into the deck so no gap opens between the two where the deck
 * slopes — the post's bottom face is inside the slab, which also means it is never a
 * coplanar surface fighting the carriageway for pixels. */
const POST_EMBED = 0.04;

interface RailPoint {
  x: number;
  y: number;
  z: number;
  /** Parapet height at this point, already faded in by the deck's own lift. */
  height: number;
}

/**
 * Parapet height for a given lift above the road's at-grade baseline. Smoothstep rather
 * than a linear ramp so the railing neither pops nor spends the whole approach as a
 * knee-high stub.
 */
export function railingHeightForLift(lift: number): number {
  const t = Math.min(1, Math.max(0, (lift - RAILING_START_LIFT) / (RAILING_FULL_LIFT - RAILING_START_LIFT)));
  return RAILING_HEIGHT * t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Samples one edge of the deck at post spacing: the mitered edge offset pulled in by
 * `RAILING_INSET`, the profile's own height, and the parapet height that lift earns.
 *
 * Sampling the *edge* polyline (rather than the centreline, offset afterwards) is what
 * keeps a post on the deck through a bend: the ribbon's own edge vertices are the mitered
 * ones, and anything interpolated between two of them lies exactly on the carriageway's
 * boundary, which is not true of a centreline point offset by a constant.
 */
function sampleEdge(
  points: readonly LocalPoint[],
  elevations: readonly number[],
  lifts: readonly number[],
  width: number,
  side: 1 | -1,
): RailPoint[] {
  const half = width / 2;
  // Insetting by scaling the offset keeps the miter stretch intact while moving the line
  // `RAILING_INSET` meters across the carriageway; subtracting a constant from the offset
  // vector's length instead would cut a sharp bend's stretch off with it.
  const insetScale = Math.max(0, (half - RAILING_INSET) / half);
  const frames = roadRibbonFrames(points, width);
  const edge = points.map((point, index) => ({
    x: point.x + frames[index].offsetX * insetScale * side,
    y: elevations[index],
    z: point.z + frames[index].offsetZ * insetScale * side,
    height: railingHeightForLift(lifts[index]),
  }));

  const samples: RailPoint[] = [];
  for (let index = 0; index < edge.length - 1; index += 1) {
    const a = edge[index];
    const b = edge[index + 1];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.round(span / POST_SPACING));
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      samples.push({
        x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
        height: lerp(a.height, b.height, t),
      });
    }
  }
  const last = edge[edge.length - 1];
  if (last) samples.push({ ...last });
  return samples;
}

interface Vec3 { x: number; y: number; z: number }

/**
 * Appends a rectangular prism running `a` to `b`. Its width axis is horizontal and
 * perpendicular to the run, its height axis perpendicular to both, so a rail following a
 * sloping ramp stays square to the deck rather than to the world.
 *
 * `fallbackSideX/Z` covers the vertical run a post is — there is no horizontal
 * perpendicular to "straight up", so the caller supplies the direction the section should
 * face instead.
 */
function pushPrism(
  positions: number[],
  indices: number[],
  a: Vec3,
  b: Vec3,
  halfWidth: number,
  halfHeight: number,
  fallbackSideX: number,
  fallbackSideZ: number,
): void {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return;
  const dirX = dx / length, dirY = dy / length, dirZ = dz / length;

  // The width axis: horizontal, perpendicular to the run. Degenerate for the vertical run
  // a post is, which is what the fallback direction is for.
  let sideX = -dirZ;
  let sideZ = dirX;
  const sideLength = Math.hypot(sideX, sideZ);
  if (sideLength < 1e-6) { sideX = fallbackSideX; sideZ = fallbackSideZ; }
  else { sideX /= sideLength; sideZ /= sideLength; }

  // The height axis: side x dir, which is unit (both are, and they are perpendicular) and
  // comes out pointing up for any run that is not itself vertical.
  const upX = -sideZ * dirY;
  const upY = sideZ * dirX - sideX * dirZ;
  const upZ = sideX * dirY;

  const base = positions.length / 3;
  for (const end of [a, b]) {
    for (const [across, high] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      positions.push(
        end.x + sideX * halfWidth * across + upX * halfHeight * high,
        end.y + upY * halfHeight * high,
        end.z + sideZ * halfWidth * across + upZ * halfHeight * high,
      );
    }
  }
  // 0-3 are the corners at `a`, 4-7 their counterparts at `b`, both in the same
  // (across, high) order, so every face is one quad between a pair and its counterpart.
  // Wound outward throughout — the material is FrontSide, and an inward-facing railing is
  // an invisible one.
  const quad = (p0: number, p1: number, p2: number, p3: number) => {
    indices.push(base + p0, base + p1, base + p2, base + p0, base + p2, base + p3);
  };
  quad(0, 1, 2, 3); // cap at `a`, facing back along the run
  quad(7, 6, 5, 4); // cap at `b`
  quad(0, 4, 5, 1);
  quad(1, 5, 6, 2);
  quad(2, 6, 7, 3);
  quad(3, 7, 4, 0);
}

/**
 * Railing geometry for one road, or `null` where the road never stands high enough off its
 * own baseline to need one.
 *
 * `points`/`elevations` are the road's *extended* polyline and its profile heights — the
 * very arrays the carriageway was built from, passed in rather than recomputed, so the two
 * cannot disagree about where the deck is. `lifts` is each point's height above the road's
 * at-grade baseline; a tagged bridge is floored at full parapet height along its whole
 * span, because a surveyed structure has a railing end to end whether or not the profile
 * found something for it to clear.
 */
export function buildRoadRailingGeometry(
  road: WorldRoad,
  points: readonly LocalPoint[],
  elevations: readonly number[],
  lifts: readonly number[],
  profiles?: Map<string, RoadElevationProfile>,
): THREE.BufferGeometry | null {
  if (points.length < 2 || road.width <= 2 * RAILING_INSET) return null;
  const effectiveLifts = road.structure === 'bridge'
    ? lifts.map((lift) => Math.max(lift, RAILING_FULL_LIFT))
    : lifts;
  if (!effectiveLifts.some((lift) => railingHeightForLift(lift) >= MIN_RAILING_HEIGHT)) return null;

  const positions: number[] = [];
  const indices: number[] = [];
  // Compare deck heights, not layer tags: a ramp can join a tagged span at the same Y.
  const inJunction = (x: number, y: number, z: number) => profiles
    ? roadElevationAtPoint(x, z, profiles, 0.15, y + 0.3, y - 0.3, road.id) !== null
    : false;
  const crossesJunction = (a: RailPoint, b: RailPoint) => {
    if (!profiles) return false;
    // Include the rail's interior so a narrow path between two posts still gets an opening.
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.2));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      if (inJunction(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t))) return true;
    }
    return false;
  };

  for (const side of [1, -1] as const) {
    const samples = sampleEdge(points, elevations, effectiveLifts, road.width, side);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample.height >= MIN_RAILING_HEIGHT && !inJunction(sample.x, sample.y, sample.z)) {
        pushPrism(
          positions, indices,
          { x: sample.x, y: sample.y - POST_EMBED, z: sample.z },
          { x: sample.x, y: sample.y + sample.height, z: sample.z },
          POST_HALF, POST_HALF, 1, 0,
        );
      }
      const next = samples[index + 1];
      // A rail spans two posts, so it needs both of them to exist — which is also what
      // makes the parapet end cleanly where the ramp reaches grade instead of trailing a
      // rail off into the road surface.
      if (!next || sample.height < MIN_RAILING_HEIGHT || next.height < MIN_RAILING_HEIGHT || crossesJunction(sample, next)) continue;
      pushPrism(
        positions, indices,
        { x: sample.x, y: sample.y + sample.height, z: sample.z },
        { x: next.x, y: next.y + next.height, z: next.z },
        TOP_RAIL_HALF_WIDTH, TOP_RAIL_HALF_HEIGHT, 1, 0,
      );
      pushPrism(
        positions, indices,
        { x: sample.x, y: sample.y + sample.height * 0.5, z: sample.z },
        { x: next.x, y: next.y + next.height * 0.5, z: next.z },
        MID_RAIL_HALF_WIDTH, MID_RAIL_HALF_HEIGHT, 1, 0,
      );
    }
  }

  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Galvanised steel: dark, fairly rough, and metallic enough to pick up the sky the way a
 * parapet does against water. Shared for the world's lifetime like the facade materials —
 * a rebuild reuses it rather than disposing and recreating one per snapshot. */
export function createRailingMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x53575b, roughness: 0.55, metalness: 0.6 });
}
