/**
 * The columns and abutments that hold a road deck up.
 *
 * Decks and their approach ramps already render as closed slabs with parapets along both
 * edges, and they already cast shadows — onto ground with nothing standing between it and
 * the deck. A viaduct with no visible support reads as a decal floating over the city
 * rather than as a structure, and the shadow is what gives it away: a dark band across the
 * park with nothing casting it.
 *
 * Placement is pure arithmetic over the deck's own samples — the same extended polyline,
 * profile heights and lifts the carriageway and the railings were built from, passed in
 * rather than recomputed, so a pier cannot end up under a deck that is somewhere else.
 * `buildBridgePierGeometry` is the only part that touches three.js.
 */
import * as THREE from 'three';
import type { LocalPoint, WorldRoad } from './types';

/**
 * Lift at which a deck starts to want a support, in metres above the road's own at-grade
 * baseline — the same quantity `deckThicknessProfile` tapers its slab over, and set at the
 * same `ROAD_DECK_LIFT` the slab reaches full thickness at.
 *
 * Below this the deck is a kerb-height rise in the road, not a structure: it has no
 * daylight under it to put a column in, and a pier there would be a post jammed into the
 * ground beside the carriageway.
 */
const MIN_PIER_LIFT = 1.5;

/**
 * Target distance between columns along the deck, in metres.
 *
 * Real concrete road viaducts span 20–40m between piers; below that the deck is cheaper to
 * build as an embankment, and much above it wants a box girder or a cable stay, neither of
 * which this world models. 26m sits in the middle of that band, so a span reads as
 * plausibly engineered at the two distances it is actually seen from — from the road
 * beneath it, and from a rooftop across the water.
 *
 * It is a *target*, not a step: each elevated run divides its own length into whole
 * spans (see `pierPlacements`), so piers land symmetrically within the run instead of
 * marching from one end and leaving a ragged offcut at the other.
 */
const TARGET_PIER_SPACING = 26;

/** Half-thickness of a column, in metres — a 1.4m square section, which is what carries a
 * two-lane deck without reading as either a pencil or a plinth. */
const PIER_HALF = 0.7;

/**
 * How far a column's foot is sunk below the road's at-grade baseline.
 *
 * The baseline is the height the road would sit at if it were not lifted, which is this
 * world's best available answer for "the ground under the deck" — the deck's own lift is
 * measured against it, so it is exactly the quantity that makes a pier the right height.
 * It is not a terrain sample: over water, or where the ground beneath falls away from the
 * road's own baseline, the foot is buried or hangs. Embedding it keeps the common case
 * (a deck over roughly level ground) clean, and the limitation is called out in
 * `docs/performance` rather than papered over. Sampling true ground under the deck needs
 * a terrain query per pier and is deferred until something asks for it.
 */
const PIER_FOOT_EMBED = 0.6;

/**
 * Half-depth of an abutment along the road, in metres. An abutment is the solid wall where
 * a deck hands over to its approach embankment, so it is short along the road and as wide
 * across it as the deck — quite unlike the columns between them.
 */
const ABUTMENT_HALF_DEPTH = 0.9;

/** Metres the supports are inset from the deck's painted edge, so a pier reads as carrying
 * the slab rather than as flush wall cladding hung off its side. */
const SUPPORT_INSET = 0.35;

export type PierKind = 'column' | 'abutment';

/** One support, in world metres. `dirX`/`dirZ` is the deck's horizontal direction here, so
 * the box can be squared to the road rather than to the world. */
export interface PierPlacement {
  kind: PierKind;
  x: number;
  z: number;
  /** Underside of the deck — the top face of the support. */
  topY: number;
  /** Bottom face, already embedded below the baseline. */
  baseY: number;
  halfWidth: number;
  halfDepth: number;
  dirX: number;
  dirZ: number;
}

export interface PierOptions {
  /** True where something else already occupies the ground under this point — another
   * road's carriageway, most importantly. Injected rather than queried here so the
   * placement stays pure and testable; `threeWorld` passes the same road-elevation lookup
   * the railings use to open their parapets at junctions.
   *
   * A pier dropped into the road running under the viaduct is worse than no pier at all:
   * it is a concrete block in a live carriageway, and it is exactly where the underpass
   * the deck exists to cross is. */
  isObstructed?: (x: number, z: number, deckUndersideY: number) => boolean;
  spacing?: number;
}

interface DeckSample {
  x: number;
  z: number;
  y: number;
  lift: number;
  /** Distance along the deck from its first point. */
  along: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolates the deck at a distance along it, clamped to its ends. */
function sampleAt(samples: readonly DeckSample[], along: number): DeckSample {
  const last = samples[samples.length - 1];
  if (along <= samples[0].along) return samples[0];
  if (along >= last.along) return last;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index];
    const b = samples[index + 1];
    if (along > b.along) continue;
    const span = b.along - a.along;
    const t = span < 1e-6 ? 0 : (along - a.along) / span;
    return {
      x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t),
      y: lerp(a.y, b.y, t), lift: lerp(a.lift, b.lift, t), along,
    };
  }
  return last;
}

/** Deck direction at a distance along it, for squaring a support to the road. */
function directionAt(samples: readonly DeckSample[], along: number): { dirX: number; dirZ: number } {
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index];
    const b = samples[index + 1];
    if (along > b.along && index < samples.length - 2) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    return { dirX: dx / length, dirZ: dz / length };
  }
  return { dirX: 1, dirZ: 0 };
}

/**
 * Contiguous stretches of deck genuinely standing in the air, as [startAlong, endAlong].
 *
 * A road is not uniformly a bridge: a profile lifts an approach ramp out of the street,
 * holds it across the span, and sets it back down, and only the middle of that wants
 * supports. Boundaries are interpolated to the exact crossing of `MIN_PIER_LIFT` rather
 * than snapped to the nearest sample, so an abutment sits where the deck actually leaves
 * the ground instead of up to a segment early.
 */
function elevatedRuns(samples: readonly DeckSample[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  const crossing = (a: DeckSample, b: DeckSample): number => {
    const span = b.lift - a.lift;
    if (Math.abs(span) < 1e-9) return a.along;
    return lerp(a.along, b.along, (MIN_PIER_LIFT - a.lift) / span);
  };
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const high = sample.lift >= MIN_PIER_LIFT;
    const previous = samples[index - 1];
    if (high && start === null) {
      start = previous ? crossing(previous, sample) : sample.along;
    } else if (!high && start !== null) {
      runs.push([start, crossing(previous, sample)]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, samples[samples.length - 1].along]);
  return runs;
}

/**
 * Where a deck's supports stand.
 *
 * `points`/`elevations`/`lifts` are the road's extended polyline and its profile heights —
 * the arrays `roadDeckSamples` produced and the carriageway was built from. `thickness` is
 * the per-point slab depth (`deckThicknessProfile`), so a support stops at the underside of
 * the slab rather than poking through the road surface.
 *
 * Each elevated run gets an abutment at both ends and columns evenly spaced between them.
 * The column count comes from rounding the run's length to whole spans, so a 30m run gets
 * one column at its midpoint rather than one at 26m and a 4m offcut, and a run shorter than
 * a single span gets none at all — just the two abutments, which is how a short overbridge
 * is actually built.
 */
export function pierPlacements(
  points: readonly LocalPoint[],
  elevations: readonly number[],
  lifts: readonly number[],
  thickness: readonly number[] | null,
  width: number,
  options: PierOptions = {},
): PierPlacement[] {
  if (points.length < 2 || width <= 2 * SUPPORT_INSET) return [];
  const spacing = options.spacing ?? TARGET_PIER_SPACING;
  if (!(spacing > 0)) return [];

  const samples: DeckSample[] = [];
  let along = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (index > 0) {
      const previous = points[index - 1];
      along += Math.hypot(point.x - previous.x, point.z - previous.z);
    }
    samples.push({ x: point.x, z: point.z, y: elevations[index] ?? 0, lift: lifts[index] ?? 0, along });
  }
  if (samples[samples.length - 1].along < 1e-6) return [];

  // The slab's own depth at a distance along the deck, so a support meets the underside.
  const depthAt = (target: number): number => {
    if (!thickness) return 0;
    let index = 0;
    while (index < samples.length - 2 && samples[index + 1].along < target) index += 1;
    const a = samples[index];
    const b = samples[index + 1] ?? a;
    const span = b.along - a.along;
    const t = span < 1e-6 ? 0 : Math.min(1, Math.max(0, (target - a.along) / span));
    return lerp(thickness[index] ?? 0, thickness[index + 1] ?? thickness[index] ?? 0, t);
  };

  const halfWidth = Math.max(0.1, width / 2 - SUPPORT_INSET);
  const placements: PierPlacement[] = [];
  const place = (target: number, kind: PierKind): void => {
    const sample = sampleAt(samples, target);
    const topY = sample.y - depthAt(target);
    const baseY = sample.y - sample.lift - PIER_FOOT_EMBED;
    // A support with no height is a flat plate at deck level; skip it rather than emit
    // inverted geometry. Can happen where a run's own boundary sits at the lift threshold.
    if (topY - baseY < 0.05) return;
    // Asked after the deck underside is known rather than before, because whether
    // something is in this support's way depends on how far under the deck it passes —
    // see `createRoadObstructionTest`.
    if (options.isObstructed?.(sample.x, sample.z, topY)) return;
    const { dirX, dirZ } = directionAt(samples, target);
    placements.push({
      kind, x: sample.x, z: sample.z, topY, baseY,
      halfWidth: kind === 'abutment' ? halfWidth : PIER_HALF,
      halfDepth: kind === 'abutment' ? ABUTMENT_HALF_DEPTH : PIER_HALF,
      dirX, dirZ,
    });
  };

  for (const [start, end] of elevatedRuns(samples)) {
    const length = end - start;
    if (length < 1e-6) continue;
    place(start, 'abutment');
    // Whole spans, so columns sit symmetrically inside the run. `round` rather than
    // `ceil`: a run a little over one span reads better as a single clear span than as
    // one column crowded against an abutment.
    const spans = Math.max(1, Math.round(length / spacing));
    for (let index = 1; index < spans; index += 1) place(start + (length * index) / spans, 'column');
    if (length > 1e-6) place(end, 'abutment');
  }
  return placements;
}

/**
 * One merged geometry for every support on a road, or `null` where it has none.
 *
 * Merged here rather than one mesh per pier for the same reason the carriageways and the
 * parapets are: a viaduct's columns are a dozen boxes that share a material, and each one
 * as its own mesh is a draw call and a shadow-map submission that buys nothing.
 */
export function buildBridgePierGeometry(placements: readonly PierPlacement[]): THREE.BufferGeometry | null {
  if (!placements.length) return null;
  const positions: number[] = [];
  const indices: number[] = [];

  for (const pier of placements) {
    // Across the road, horizontal and perpendicular to its direction.
    const acrossX = -pier.dirZ;
    const acrossZ = pier.dirX;
    const base = positions.length / 3;
    for (const y of [pier.baseY, pier.topY]) {
      for (const [across, along] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        positions.push(
          pier.x + acrossX * pier.halfWidth * across + pier.dirX * pier.halfDepth * along,
          y,
          pier.z + acrossZ * pier.halfWidth * across + pier.dirZ * pier.halfDepth * along,
        );
      }
    }
    // 0-3 are the foot's corners, 4-7 the head's, in the same (across, along) order.
    // Wound outward: the material is FrontSide, and an inward-facing pier is an invisible
    // one. The foot is wound the other way round from the head for the same reason.
    const quad = (p0: number, p1: number, p2: number, p3: number) => {
      indices.push(base + p0, base + p1, base + p2, base + p0, base + p2, base + p3);
    };
    quad(3, 2, 1, 0); // foot, facing down
    quad(4, 5, 6, 7); // head, facing up
    quad(0, 1, 5, 4);
    quad(1, 2, 6, 5);
    quad(2, 3, 7, 6);
    quad(3, 0, 4, 7);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Weathered structural concrete — lighter and far rougher than the parapet steel it
 * stands under, so the two read as different materials at a glance. Shared for the world's
 * lifetime like the railing material, rather than rebuilt per snapshot. */
export function createPierMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.92, metalness: 0.02 });
}

/**
 * Extra clearance around a road that a support must keep out of, in metres — half a
 * column, so the box's own face clears the carriageway edge rather than its centre.
 */
const OBSTRUCTION_CLEARANCE = PIER_HALF;

/**
 * How far below the deck's underside another road has to pass before a support standing
 * there counts as being in its way, in metres.
 *
 * Without this the test was purely horizontal, and it rejected three supports in four.
 * Measured over the committed Gärdet cache: of 184 rejected supports, 147 were rejected by
 * a road whose surface sat 0.45m *above* the deck underside — which is the deck's own top
 * face, one deck-thickness up. Those blockers were the viaduct's own continuation ways and
 * the neighbouring carriageways on the same structure, none of which a support can
 * possibly be standing in. Genuine underpasses clustered separately, around 4.5m below,
 * with an almost empty gap between the two groups.
 *
 * The floor on the useful range is set by the shallowest deck that gets supports at all:
 * at `MIN_PIER_LIFT` the underside sits only about a metre above the baseline, so a street
 * running under it drops about that much. A quarter of a metre sits well clear of the
 * same-level group and well under that floor, so it separates the two cases without
 * needing either to be measured precisely.
 */
const MIN_UNDERPASS_DROP = 0.25;

/**
 * Squared distance from a point to a segment. Squared throughout: this runs per candidate
 * road segment per support, and the comparison against a squared radius is exact.
 */
function distanceSqToSegment(x: number, z: number, a: LocalPoint, b: LocalPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 1e-12) return (x - a.x) ** 2 + (z - a.z) ** 2;
  const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
  return (x - (a.x + dx * t)) ** 2 + (z - (a.z + dz * t)) ** 2;
}

/**
 * An `isObstructed` predicate that keeps supports out of the roads running beneath a deck.
 *
 * This is the case the profiled-road lookup cannot answer on its own. Only roads that
 * grade separation actually reached carry a `RoadElevationProfile` — the overwhelming
 * majority of streets are absent from that map by design — so asking it whether something
 * is under the deck misses exactly the ordinary street a viaduct is most often built over.
 * This reads the road set directly instead.
 *
 * Candidates are narrowed once, by bounding box around the deck, so the per-support work
 * is a scan of the few roads actually near this bridge rather than of the whole world.
 * Decks are a small minority of roads and are only supported within the detail radius, so
 * this stays bounded even though it is a linear scan.
 */
export function createRoadObstructionTest(
  roads: readonly WorldRoad[],
  excludeRoadId: string,
  deckPoints: readonly LocalPoint[],
  /**
   * That road's own surface height at a point, in metres. Injected rather than derived
   * here because answering it needs the elevation profiles, which live a layer up — the
   * same reason `isObstructed` is injected into `pierPlacements` rather than queried
   * inside it. For a road with no profile the honest answer is its at-grade surface
   * elevation, which is what makes an ordinary street under a viaduct read correctly.
   */
  surfaceHeightAt: (road: WorldRoad, x: number, z: number) => number,
  clearance: number = OBSTRUCTION_CLEARANCE,
): (x: number, z: number, deckUndersideY: number) => boolean {
  if (!deckPoints.length) return () => false;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of deckPoints) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  // Padded by the widest thing that could still reach a support standing on the deck's
  // own line: half a generous carriageway plus the clearance.
  const pad = 30 + clearance;
  // Bounding boxes are compared as boxes, not by testing whether either road's *vertices*
  // land in the other's. A road crossing the deck at right angles is the whole point of
  // this test, and its two endpoints are typically well outside the deck's box while the
  // segment between them runs straight through it — a vertex test drops exactly the
  // underpass it is supposed to find.
  const candidates = roads.filter((road) => {
    if (road.id === excludeRoadId || road.points.length < 2) return false;
    let roadMinX = Infinity, roadMaxX = -Infinity, roadMinZ = Infinity, roadMaxZ = -Infinity;
    for (const point of road.points) {
      roadMinX = Math.min(roadMinX, point.x); roadMaxX = Math.max(roadMaxX, point.x);
      roadMinZ = Math.min(roadMinZ, point.z); roadMaxZ = Math.max(roadMaxZ, point.z);
    }
    return roadMaxX >= minX - pad && roadMinX <= maxX + pad
      && roadMaxZ >= minZ - pad && roadMinZ <= maxZ + pad;
  });
  if (!candidates.length) return () => false;

  return (x: number, z: number, deckUndersideY: number): boolean => {
    for (const road of candidates) {
      const radius = road.width / 2 + clearance;
      const radiusSq = radius * radius;
      let withinCarriageway = false;
      for (let index = 0; index < road.points.length - 1; index += 1) {
        if (distanceSqToSegment(x, z, road.points[index], road.points[index + 1]) <= radiusSq) {
          withinCarriageway = true;
          break;
        }
      }
      if (!withinCarriageway) continue;
      // Only now ask how high this road is. The height lookup is much the dearer half and
      // nearly every candidate fails the distance test first, so asking in this order
      // keeps the common case exactly as cheap as it was before heights were consulted.
      //
      // Standing near a road is not enough to be in its way: a viaduct is usually built
      // along a corridor it shares with the street it crosses, and the deck's own
      // continuation ways run directly along its line. Only a road that genuinely passes
      // *beneath* this support can have the support standing in it.
      if (surfaceHeightAt(road, x, z) <= deckUndersideY - MIN_UNDERPASS_DROP) return true;
    }
    return false;
  };
}
