/**
 * Deterministic siting for backlog item 15's stable: an OSM-tagged candidate when the
 * data supports one, a procedural forest clearing otherwise. See
 * docs/2026-08-04-stable-tile-probe.md — the live tile schema this game fetches
 * (OpenFreeMap/OpenMapTiles-derived) does not currently carry stable-related tagging at
 * all, at either the geometry (`building`) or semantic (`poi`) layer, so in practice the
 * procedural path is the one that fires today. The OSM-candidate matcher below is kept
 * anyway, against the plausible OSM vocabulary, for any `WorldData` source that does
 * carry it (a future direct-OSM path, or a hand-authored World Editor world).
 *
 * The procedural fallback reuses the exact deterministic-hash pattern `vegetation.ts`
 * uses to scatter trees (`hashed(seed, a, b)`, FNV-1a over a string plus two integers) —
 * same reasoning applies here: a stable must stay put across world rebuilds, so its
 * position is a pure function of the world seed and the forest polygon it lands in,
 * never of accumulated random state.
 */
import { hashed, pointInRing } from '../vegetation';
import type { LocalPoint, WorldArea, WorldObject } from '../types';

/** Beyond this, a mapped stable is too far from the player's world to route a quest
 * through — the same order of magnitude as the tree-scatter and streaming radius this
 * game already works in. */
export const STABLE_OSM_MATCH_RANGE_METERS = 2_000;

/** Plausible OSM tags for a stable/equestrian facility. Nothing here has been observed
 * to survive into this game's tile source (see the probe doc); this matches against raw
 * `properties` on a `WorldObject`, which is the shape a differently-sourced world could
 * still deliver. */
function isStableCandidate(properties: Record<string, unknown>): boolean {
  return (
    properties.amenity === 'stable'
    || properties.building === 'stable'
    || properties.leisure === 'horse_riding'
    || properties.sport === 'equestrian'
  );
}

/** Landuse/landcover kinds this game already treats as forest — see vegetation.ts's
 * SPECIES table, which plants the same two kinds densely and coniferously. */
const FOREST_KINDS = new Set(['forest', 'wood']);

export interface StableSiting {
  x: number;
  z: number;
  source: 'osm' | 'procedural';
  /** Which polygon or object supplied the placement, for debugging/inspection. */
  fromId: string;
  justification: string;
}

interface StableSitingInput {
  objects: WorldObject[];
  areas: WorldArea[];
}

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Picks a clearing point inside a forest polygon, using the same jittered-grid-cell
 * approach `generateTrees` uses, but selecting a single deterministic cell rather than
 * filling the whole polygon — the stable needs one clearing, not a stand of trees. */
function forestClearingPoint(area: WorldArea, seed: number): LocalPoint {
  const ring = area.rings[0];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of ring) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  const seedKey = `${area.id}:${seed}`;
  // Walk a small deterministic sequence of candidate cells until one lands inside the
  // polygon (a non-convex ring can reject the first few tries near its own edges).
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const jitterX = hashed(seedKey, attempt, 11);
    const jitterZ = hashed(seedKey, attempt, 29);
    const point = { x: minX + jitterX * (maxX - minX), z: minZ + jitterZ * (maxZ - minZ) };
    if (pointInRing(point, ring)) return point;
  }
  // Degenerate polygon (all attempts missed) — fall back to its centroid.
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * Sites the stable for one world. `seed` is the world seed (same role as the `seed`
 * field on `ProceduralWorldProject`); the result is a pure function of `input` and
 * `seed`, so the same world produces the same stable every time it is rebuilt.
 */
export function siteStable(input: StableSitingInput, seed: number): StableSiting {
  const candidates = input.objects.filter((object) => isStableCandidate(object.properties));
  if (candidates.length > 0) {
    // Deterministic tie-break: closest to the world origin, then by id.
    const sorted = [...candidates].sort((a, b) => {
      const da = distance(a.point, { x: 0, z: 0 });
      const db = distance(b.point, { x: 0, z: 0 });
      return da !== db ? da - db : a.id.localeCompare(b.id);
    });
    const nearest = sorted[0];
    const rangeOk = distance(nearest.point, { x: 0, z: 0 }) <= STABLE_OSM_MATCH_RANGE_METERS;
    if (rangeOk) {
      return {
        x: nearest.point.x,
        z: nearest.point.z,
        source: 'osm',
        fromId: nearest.id,
        justification: `sited from OSM candidate ${nearest.id} (tagged as a stable) within `
          + `${STABLE_OSM_MATCH_RANGE_METERS}m of the world origin`,
      };
    }
  }

  const forests = input.areas.filter((area) => FOREST_KINDS.has(area.kind) && area.rings.length > 0);
  if (forests.length === 0) {
    throw new Error(
      'siteStable: no OSM stable candidate in range and no forest/wood area to place a '
      + 'clearing in — this world has no valid site for the stable',
    );
  }
  // Deterministic choice of which forest polygon gets the stable.
  const index = Math.floor(hashed(`stable-forest:${seed}`, forests.length, 7) * forests.length);
  const chosen = forests[Math.min(index, forests.length - 1)];
  const point = forestClearingPoint(chosen, seed);
  return {
    x: point.x,
    z: point.z,
    source: 'procedural',
    fromId: chosen.id,
    justification: `no OSM stable candidate in range; placed procedurally as a forest `
      + `clearing in ${chosen.kind} polygon ${chosen.id}, deterministic for seed ${seed}`,
  };
}
