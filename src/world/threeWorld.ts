/**
 * Builds and owns the full Three.js scene graph for one WorldData snapshot: ground,
 * parks, water, roads, buildings/roofs, facades, and street furniture. `replace()`
 * tears down and rebuilds everything under one `root` group each time new world
 * data or render options arrive — simple to reason about, at the cost of not
 * diffing (acceptable at this world's scale).
 *
 * Surfaces are layered by small, deliberate Y offsets (ground < water < parks <
 * roads) plus matching `polygonOffset` so near-coplanar layers don't z-fight.
 */
import * as THREE from 'three';
import { generateStreetFurniture } from './streetFurniture';
import { buildFacadeRecord, type SvartaksiFacadeBuilding } from './facadeRecords';
import { createFacadeRenderer, type SvartaksiFacadeRenderer } from './facadeRenderer';
import { createWindowLights } from './windowLights';
import { createBuildScheduler, type BuildJob } from './buildScheduler';
import type { LocalPoint, WorldArea, WorldBuilding, WorldData, WorldRoad } from './types';
import {
  DEFAULT_RENDER_OPTIONS,
  onlyWindowOptionsChanged,
  resolveEffectiveRenderQuality,
  type EffectiveRenderQuality,
  type RenderOptions,
} from './renderOptions';
import { getOrCreateRoadMaterial, getRoadStyleKey, type RoadStyleKey } from '../svartaksi/roadStyle';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { isSurfaceVisible } from './surfaceVisibility';
import { createRoadSliceBudget, roadPaintDistance, ROAD_GEOMETRY_POINT_BUDGET } from './roadDrawPolicy';
import { generateStreetLightsJob, type LampPlacement } from './streetLights';
import { roadRibbonFrames, roadEndpointExtension, extendRoadEndpoints } from './roadRibbon';
import { bridgeDeckColliders, bridgeRailingColliders, type BridgeCollider } from './bridgeColliders';
import { buildRoadRailingGeometry, createRailingMaterial } from './bridgeRailings';
import { buildBridgePierGeometry, createPierMaterial, createRoadObstructionTest, pierPlacements } from './bridgePiers';
import { generateBusStopsJob, type BusStopPlacement } from './busStops';
import { generateMailboxesJob, mappedMailboxesJob, type MailboxPlacement } from './mailboxes';
import { createTrafficLights, findTrafficSignalsJob, type TrafficLightBatch } from '../svartaksi/trafficLights';
import { createNeonSigns, generateNeonSignsJob, type NeonSignBatch } from '../svartaksi/neonSigns';
import { generateTreesJob, mappedTrees, type TreePlacement } from './vegetation';
import type { WorldProp } from './propRegistry';
import {
  busStopProps,
  mailboxProps,
  mappedObjectProps,
  streetLightProps,
  trafficSignalProps,
  treeProps,
} from './registerWorldProps';
import { ringBounds, ringCentroid } from './geo';
import { WATER_SHELF_WIDTH } from './waterIndex';
import {
  buildTerrainIndex,
  insetRing,
  stableNumber,
  terrainClearanceFor,
  terrainHeightAtIndexed,
  terrainHeightAtXZIndexed,
  waterSurfaceHeightAtIndexed,
  type TerrainClearance,
  type TerrainIndex,
} from './terrain';
import {
  buildRoadElevationProfilesJob,
  BRIDGE_DECK_THICKNESS,
  isElevatedRoadProfile,
  roadElevationAtPoint,
  ROAD_DECK_LIFT,
  sampleRoadElevation,
  type RoadElevationProfile,
} from './roadElevationProfile';
import { buildParkGeometry } from './terrainGeometry';
import { resolveRoofStyle } from '../svartaksi/roofStyle';
import { applyLogDepthBias, DEPTH_BIAS } from './depthBias';
import {
  createShallowsMaterial,
  createShorelineFoamMaterial,
  createWaterMaterial,
  landuseMaterialOptions,
  setWaterAnimationTime,
} from './worldMaterials';
import { applySceneLighting, type SceneLighting } from './shaderLighting';
import {
  INSPECTION_USER_DATA_KEY,
  sanitizeInspectionProperties,
  type WorldInspectionRecord,
} from './inspection';

/**
 * Everything about where a road's surface actually is, in one value: the polyline extended
 * past each mapped endpoint, the height of the deck at every one of those points, and how
 * far each of those stands over the road's own at-grade baseline.
 *
 * The carriageway, its slab walls, and its railings are three separate meshes in two
 * different materials, and all three have to agree to the millimetre about where the deck
 * is or the bridge visibly comes apart. Deriving all of them from one function is what
 * makes that structural rather than a matter of keeping three copies in step.
 *
 * `lifts` is the quantity `ROAD_DECK_LIFT` is expressed in: height above the road's own
 * class-based ground offset, so it is zero for the overwhelming majority of roads and only
 * grows where grade separation reached them.
 */
export interface RoadDeckSamples {
  points: LocalPoint[];
  elevations: number[];
  baseElevation: number;
  lifts: number[];
}

export function roadDeckSamples(
  road: WorldRoad,
  terrain: TerrainClearance[] = [],
  profile?: RoadElevationProfile,
  terrainIndex?: TerrainIndex,
): RoadDeckSamples {
  const points = extendRoadEndpoints(road.points, road.width);
  const baseElevation = roadSurfaceElevation(road);
  const elevations = points.length < 2
    ? points.map(() => baseElevation)
    : profile
      ? sampleProfileAtExtendedPoints(profile, road.points, points)
      : smoothedRoadElevations(points, baseElevation, terrain, terrainIndex ?? buildTerrainIndex(terrain));
  return { points, elevations, baseElevation, lifts: elevations.map((y) => y - baseElevation) };
}

/**
 * Builds one continuous ribbon for the whole polyline instead of stitching
 * independent quads per segment — each interior point gets a *mitered* normal
 * (the bisector of its two adjacent segment normals, stretched to keep the
 * road's true width across the bend) so consecutive segments share exact edge
 * vertices and the road reads as one cohesive line instead of a chain of
 * slightly gapped/overlapping slabs at every corner.
 *
 * Also emits `aRoadUV`: x is distance along the road in meters (for dash
 * phase), y is -1..1 across the width (for the center line and edge fade), and z ramps
 * 0..1 across the endpoint extension so the shader can dissolve each tip (see below) —
 * except where the tip is up on a deck, which has an approach ramp to hand over to
 * rather than ground to dissolve against.
 *
 * `terrain` (see computeTerrainClearance) lets a road rise above whichever park/landuse
 * mound it happens to pass through instead of being buried inside it — see the doc
 * comment on computeTerrainClearance for why that's needed at all.
 *
 * Each end is extended slightly past its own mapped endpoint (see extendRoadEndpoints)
 * so two roads meant to meet at a shared junction node visually overlap there instead
 * of leaving a hairline gap from tiny coordinate mismatches between the source ways.
 *
 * `profile`, when given, is this road's own `RoadElevationProfile` (see
 * roadElevationProfile.ts) — the same sampled heights physics reads through
 * `roadElevationAtPoint`/`sampleRoadElevation`, so a bridge deck or tunnel dig renders
 * exactly where a vehicle driving it will actually be grounded. Omitted, this falls
 * back to the plain terrain-clearance smoothing every ordinary road already used.
 */
export function buildRoadGeometry(
  road: WorldRoad,
  terrain: TerrainClearance[] = [],
  profile?: RoadElevationProfile,
  // Optional pre-built spatial index (see terrain.ts's buildTerrainIndex) over the same
  // `terrain` array. A caller building geometry for many roads against one terrain
  // profile — the normal world-build case — builds this once and passes it through
  // rather than paying to rebuild it on every road. Falls back to indexing `terrain`
  // itself so a caller that only has the plain array (tests, the World Editor preview)
  // still gets a spatial index rather than the old per-point linear scan.
  terrainIndex?: TerrainIndex,
): THREE.BufferGeometry {
  const { points, elevations, lifts } = roadDeckSamples(road, terrain, profile, terrainIndex);
  const geometry = new THREE.BufferGeometry();
  if (points.length < 2) return geometry;

  // The tip fade spans exactly the stub extendRoadEndpoints added — the mapped endpoint
  // is still a vertex of its own, which is what pins the channel to 1 there — so the road
  // is fully opaque everywhere it was actually surveyed and only the overlap it grew for
  // junction coverage dissolves.
  const capLength = roadEndpointExtension(road.width);
  const totalLength = polylineLength(points);
  const frames = roadRibbonFrames(points, road.width);
  const positions: number[] = [];
  const roadUVs: number[] = [];
  const roadSides: number[] = [];
  let arcLength = 0;

  for (let index = 0; index < points.length; index += 1) {
    const curr = points[index];
    const y = elevations[index];
    const { normalX: nx, normalZ: nz, offsetX: offX, offsetZ: offZ } = frames[index];

    positions.push(curr.x + offX, y, curr.z + offZ, curr.x - offX, y, curr.z - offZ);
    // Unit across-direction (miter scale deliberately left off — this is a direction,
    // not an offset), so the shader can tilt the surface normal toward the crown. See
    // ROAD_CAMBER.
    roadSides.push(nx, 0, nz, nx, 0, nz);
    const groundedFade = capLength > 0
      ? Math.min(1, Math.min(arcLength, totalLength - arcLength) / capLength)
      : 1;
    // A tip standing off the ground has nothing to dissolve into. The dissolve is there
    // to hide the rectangular lip a ribbon otherwise ends on against the ground it lies
    // on; a deck's end hands over to the approach ramp that carries it back down (see
    // roadElevationProfile.ts's propagateRampsAcrossJunctions), so fading it only makes
    // the deck — walls, underside and end cap, which all inherit this channel — go
    // see-through exactly where the two meet.
    const lifted = Math.min(1, Math.max(0, lifts[index] / ROAD_DECK_LIFT));
    const endFade = groundedFade + (1 - groundedFade) * lifted;
    roadUVs.push(arcLength, 1, endFade, arcLength, -1, endFade);
    if (index < points.length - 1) {
      const next = points[index + 1];
      arcLength += Math.hypot(next.x - curr.x, next.z - curr.z);
    }
  }

  const indices: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = index * 2, b = index * 2 + 1, c = (index + 1) * 2, d = (index + 1) * 2 + 1;
    indices.push(a, d, b, a, c, d);
  }

  // Elevated decks get real vertical thickness: an underside ribbon plus side and end
  // walls, so the deck reads as a solid slab from below/the side instead of an infinitely
  // thin plane. Ordinary and tunnel roads are left as the single top ribbon — a tunnel's
  // "underside" is whatever terrain it was cut into, not open air, so there is nothing to
  // read as flat there.
  const thickness = deckThicknessProfile(road, lifts);
  if (thickness) extrudeDeckUnderside(points, positions, roadUVs, roadSides, indices, thickness);

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aRoadUV', new THREE.Float32BufferAttribute(roadUVs, 3));
  geometry.setAttribute('aRoadSide', new THREE.Float32BufferAttribute(roadSides, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Per-point slab thickness for a road, or `null` for the overwhelming majority that are
 * plain ribbons on the ground.
 *
 * Two things get a slab, and they have to be one continuous one or the bridge visibly
 * stops being a bridge partway along itself:
 *
 * - A road tagged `bridge` is a deck over its whole tagged span, at full thickness, on the
 *   tag alone. It is the span someone surveyed as a structure.
 * - A road the elevation profile *lifted* — an approach ramp, which OSM does not tag at all
 *   (see roadElevationProfile.ts's propagateRampsAcrossJunctions) — is a deck for as long
 *   as it is genuinely in the air. Before this, the ramp carrying a deck back to street
 *   level was drawn as a bare ribbon, so a viaduct ended in a paper streamer hanging off
 *   the end cap of its own slab.
 *
 * The ramp's thickness tapers with its lift, reaching zero exactly where the ramp reaches
 * grade, so the slab closes itself off into the ground instead of ending on a step. A
 * tagged bridge does not taper: it is a structure end to end, and its own approaches are
 * the neighbouring ways that ramp.
 */
function deckThicknessProfile(road: WorldRoad, lifts: number[]): number[] | null {
  if (road.structure === 'bridge') return lifts.map(() => BRIDGE_DECK_THICKNESS);
  let anyThickness = false;
  const thickness = lifts.map((lift) => {
    const value = BRIDGE_DECK_THICKNESS * Math.min(1, Math.max(0, lift / ROAD_DECK_LIFT));
    if (value > DECK_THICKNESS_EPSILON) anyThickness = true;
    return value;
  });
  return anyThickness ? thickness : null;
}

/** Below this (1mm) a slab has no visible depth at all, so its walls and caps are not
 * worth the triangles — the thickness taper's own "this is back at grade" test. */
const DECK_THICKNESS_EPSILON = 1e-3;

/**
 * Appends an underside ribbon (offset each point's own `thickness` below the top one
 * already written into `positions`) plus the side and end walls joining the two, turning a
 * flat ribbon into a closed slab. A per-point thickness rather than a single depth is what
 * lets an approach ramp's slab taper into the ground — see `deckThicknessProfile`. `positions`/`roadUVs`/`roadSides`/`indices` are the same arrays
 * buildRoadGeometry's top-ribbon loop just filled — the top ribbon's per-point pairs are
 * at buffer indices `[index*2, index*2+1]` (left, right), which this reads to place every
 * vertex it adds.
 *
 * **Every face group gets its own copies of the vertices it needs** rather than sharing
 * the top ribbon's. `computeVertexNormals` averages the faces meeting at a vertex, and a
 * road ribbon is only two vertices wide — so when the walls hung off the top ribbon's own
 * vertices, *every* vertex of the deck surface was a wall corner too. The deck's normal
 * came out tilted outward (measurably: 0.16 in x against a flat road's clean 0,1,0) and,
 * because the two ends contribute differently, tilted by different amounts on its two
 * sides, so a deck was lit as a shallow lopsided roof instead of as a flat carriageway.
 * The walls had the mirror-image problem: each picked up the deck's up-normal and took
 * direct sun as if it were a floor. Copies cost 8N+8 vertices per deck against 4N, on the
 * ~2% of roads that are bridges, and every face group ends up with the normal it actually
 * has.
 *
 * `aRoadUV`/`aRoadSide` values are duplicated from the corresponding top vertex: the
 * underside and edges don't need the top surface's own camber shading, only attribute
 * buffers the same length as `position` so the shared road material doesn't choke on a
 * mismatched vertex count.
 */
function extrudeDeckUnderside(
  points: LocalPoint[],
  positions: number[],
  roadUVs: number[],
  roadSides: number[],
  indices: number[],
  thickness: number[],
): void {
  const count = points.length;
  /** Copies top-ribbon vertex `source`, optionally dropped to the underside by that
   * *point's* own thickness, and returns the new vertex's own index. All three attribute
   * arrays are 3-component, so one offset indexes every one of them. */
  const copyVertex = (source: number, toUnderside: boolean): number => {
    const at = source * 3;
    const index = positions.length / 3;
    // Two top vertices per point (left, right), so the point a buffer vertex belongs to
    // is its own index halved — which is what pairs it with its entry in `thickness`.
    const drop = toUnderside ? thickness[source >> 1] : 0;
    positions.push(positions[at], positions[at + 1] - drop, positions[at + 2]);
    roadUVs.push(roadUVs[at], roadUVs[at + 1], roadUVs[at + 2]);
    roadSides.push(roadSides[at], roadSides[at + 1], roadSides[at + 2]);
    return index;
  };

  // Underside: its own pairs, wound the opposite way from the top so its normal faces down.
  const underside: number[] = [];
  for (let index = 0; index < count; index += 1) {
    underside.push(copyVertex(index * 2, true), copyVertex(index * 2 + 1, true));
  }
  for (let index = 0; index < count - 1; index += 1) {
    const a = underside[index * 2], b = underside[index * 2 + 1];
    const c = underside[(index + 1) * 2], d = underside[(index + 1) * 2 + 1];
    indices.push(a, b, d, a, d, c);
  }

  // Side walls: the left edge (…*2) and the right edge (…*2+1), each a strip running the
  // length of the deck with its own top and bottom copies.
  for (const side of [0, 1]) {
    const wall: number[] = [];
    for (let index = 0; index < count; index += 1) {
      wall.push(copyVertex(index * 2 + side, false), copyVertex(index * 2 + side, true));
    }
    for (let index = 0; index < count - 1; index += 1) {
      const topA = wall[index * 2], botA = wall[index * 2 + 1];
      const topB = wall[(index + 1) * 2], botB = wall[(index + 1) * 2 + 1];
      if (side === 0) indices.push(topA, botA, topB, topB, botA, botB);
      else indices.push(topA, topB, botA, topB, botB, botA);
    }
  }

  // End caps, so the extrusion doesn't read as hollow from directly off either tip. A tip
  // the taper has already brought back to grade has no hollow to close — the slab is zero
  // deep there — so it is skipped rather than emitted as four coincident vertices.
  const capQuad = (point: number, flip: boolean) => {
    if (thickness[point] <= DECK_THICKNESS_EPSILON) return;
    const top0 = copyVertex(point * 2, false), top1 = copyVertex(point * 2 + 1, false);
    const bot0 = copyVertex(point * 2, true), bot1 = copyVertex(point * 2 + 1, true);
    if (flip) indices.push(top0, top1, bot1, top0, bot1, bot0);
    else indices.push(top0, bot1, top1, top0, bot0, bot1);
  };
  capQuad(0, true);
  capQuad(count - 1, false);
}

const ROAD_LAYER: Record<string, number> = {
  path: 0, footway: 0, service: 1, residential: 2, street: 2,
  tertiary: 3, secondary: 4, primary: 5, trunk: 6, motorway: 7,
};

/** Vertical gap between two consecutive road classes. Wide enough to survive the
 * logarithmic depth buffer's precision at the distances roads are actually seen from
 * (roughly a millimeter at 100m), small enough that a motorway crossing a footpath
 * still reads as one road surface rather than a ramp. */
const ROAD_CLASS_STEP = 0.006;

/**
 * Stable, class-ordered road elevation: a bigger road always sits above a smaller one it
 * crosses, so intersections resolve by class instead of by whichever way happened to be
 * nearer the camera that frame.
 *
 * Deliberately *not* jittered per road id. The old version added up to 1.7mm of per-id
 * noise to separate same-class roads, which is below the depth buffer's resolution at any
 * real viewing distance — it never separated anything, it only made the layering harder to
 * reason about. Same-class overlaps are now resolved by draw order instead
 * (see roadRenderOrder), which is exact rather than approximate.
 */
export function roadSurfaceElevation(road: WorldRoad): number {
  return 0.14 + (ROAD_LAYER[road.kind] ?? 2) * ROAD_CLASS_STEP;
}

/** Number of distinct draw slots reserved per road class — see roadRenderOrder. */
const ROAD_ORDER_SLOTS = 64;

/**
 * A deterministic per-road draw slot, which is what actually kills same-class
 * intersection flicker.
 *
 * Two roads of the same class are exactly coplanar where they cross, so the depth test
 * alone cannot separate them: whichever draws second wins that pixel. Three sorts opaque
 * objects sharing a material by distance from the camera, so the winner flipped as the
 * camera moved — the shimmering seam at every junction. Pinning each road to its own
 * renderOrder makes that ordering camera-independent: one of the two roads consistently
 * covers the overlap, exactly like a real resurfaced junction, and nothing flickers.
 *
 * Classes are kept in separate bands so draw order agrees with roadSurfaceElevation
 * rather than fighting it.
 */
export function roadRenderOrder(road: WorldRoad): number {
  let hash = 0;
  for (const character of road.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return (ROAD_LAYER[road.kind] ?? 2) * ROAD_ORDER_SLOTS + (Math.abs(hash) % ROAD_ORDER_SLOTS);
}

/**
 * Draw order for the merged per-style-key road mesh (see the road block in
 * buildSurfacesInto) — one mesh per RoadStyleKey rather than one per road, so
 * `roadRenderOrder`'s per-road hash can no longer place every road in a single global
 * order. Within a merged mesh, same-class overlaps are instead resolved by triangle
 * *append* order (roads sorted by `roadRenderOrder` before merging, so a higher-class
 * road's triangles land later in the buffer and paint over a lower-class one — see the
 * merge loop). Across meshes, this table keeps the coarse class hierarchy roads already
 * had (path under minor under major under highway); the one behavior change is at the
 * rare path/minor tie at the shared layer-2 band (unmapped path kinds like cycleway
 * default there), which used to be an arbitrary hash tie-break and is now always
 * decided in minor's favor — still deterministic, just no longer hash-dependent.
 * Offset well clear of the other `renderOrder` values this scene sets (water surface/
 * shoreline use 2/3) so merged road meshes never interleave with them by accident.
 */
const ROAD_STYLE_RENDER_ORDER: Record<RoadStyleKey, number> = {
  path: 40, minor: 41, major: 42, highway: 43,
};

/**
 * Added to a deck mesh's own class render order, so every elevated road draws after every
 * ground one regardless of class. A footbridge over a motorway is still above it, and the
 * class hierarchy is preserved within each half. Wide enough to clear the four class
 * slots above without landing on anything else this scene orders.
 */
const ELEVATED_ROAD_RENDER_ORDER_OFFSET = 8;

/** One merged road draw call's worth of input: the style it paints as, whether it stands
 * off the ground (which decides the material variant and the render-order band), and the
 * per-road geometry waiting to be merged into it. */
interface RoadMeshBucket {
  styleKey: RoadStyleKey;
  elevated: boolean;
  entries: { road: WorldRoad; geometry: THREE.BufferGeometry }[];
}

function polylineLength(points: LocalPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].z - points[index].z);
  }
  return total;
}

/** Small vertical gap kept above the terrain a road clears, so the two don't sit close
 * enough to reintroduce the coplanar z-fighting the terrain extrusion (areaTerrainHeight)
 * was designed to avoid. */
const ROAD_TERRAIN_CLEARANCE = 0.08;

/** A road's raw elevation at one point: its own small class-based offset, or — where it
 * genuinely crosses a park/landuse polygon — just clear of that terrain's own extrusion
 * height. "Raw" because this alone can still step abruptly at a polygon edge; see
 * smoothedRoadElevations, which is what buildRoadGeometry actually uses. */
function clearTerrainElevation(point: LocalPoint, base: number, terrainIndex: TerrainIndex): number {
  const ground = terrainHeightAtXZIndexed(point.x, point.z, terrainIndex);
  return ground > 0 ? Math.max(base, ground + ROAD_TERRAIN_CLEARANCE) : base;
}

/** Meters of elevation change allowed per meter traveled along the road — caps how
 * steeply a road may climb to clear terrain, so crossing a park/landuse polygon reads as
 * a gentle rise-and-fall instead of a step. At 6% a full wood mound (areaTerrainHeight
 * tops out near 1.1m) ramps in over roughly 18m, shallower than a car park entrance. */
const ROAD_ELEVATION_MAX_SLOPE = 0.06;

/**
 * Per-point elevation for a whole road, spike-free: computes each point's raw
 * (independent) terrain-cleared elevation via clearTerrainElevation, then runs a
 * two-pass max-with-decay sweep (left-to-right, then right-to-left) — the standard
 * technique for a slope-limited 1D dilation — so any point that needs to be high
 * "pulls up" its neighbors gradually (bounded by ROAD_ELEVATION_MAX_SLOPE) instead of
 * jumping straight back down to baseline one vertex later.
 */
function smoothedRoadElevations(
  points: LocalPoint[],
  base: number,
  terrain: TerrainClearance[],
  terrainIndex: TerrainIndex,
): number[] {
  const raw = points.map((point) => clearTerrainElevation(point, base, terrainIndex));
  const count = raw.length;
  if (count < 2 || terrain.length === 0) return raw;

  const segmentLength: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    segmentLength.push(Math.hypot(points[index + 1].x - points[index].x, points[index + 1].z - points[index].z));
  }

  const leftToRight = raw.slice();
  for (let index = 1; index < count; index += 1) {
    leftToRight[index] = Math.max(raw[index], leftToRight[index - 1] - segmentLength[index - 1] * ROAD_ELEVATION_MAX_SLOPE);
  }
  const rightToLeft = raw.slice();
  for (let index = count - 2; index >= 0; index -= 1) {
    rightToLeft[index] = Math.max(raw[index], rightToLeft[index + 1] - segmentLength[index] * ROAD_ELEVATION_MAX_SLOPE);
  }
  return raw.map((_, index) => Math.max(leftToRight[index], rightToLeft[index]));
}

/**
 * Maps a road's `RoadElevationProfile` (sampled at the road's own, un-extended
 * `road.points`) onto `extendedPoints` (see extendRoadEndpoints) by distance along the
 * original polyline. The two stub points extendRoadEndpoints adds fall outside the
 * profile's own span and clamp to its nearest end height — consistent with the profile's
 * own end behavior (`sampleRoadElevation`), and correct rather than merely close now that
 * a deck's endpoint height is the height its approach ramp continues from: a flat stub is
 * exactly what carries the deck the last half-width into the junction it hands over at.
 */
function sampleProfileAtExtendedPoints(
  profile: RoadElevationProfile,
  originalPoints: LocalPoint[],
  extendedPoints: LocalPoint[],
): number[] {
  // extendedPoints is originalPoints with one stub prepended and one appended, so
  // extended index i is original index i-1, clamped at both ends onto the profile's own
  // first/last sample.
  let distanceAlong = 0;
  const distances: number[] = [0];
  for (let index = 1; index < originalPoints.length; index += 1) {
    distanceAlong += Math.hypot(
      originalPoints[index].x - originalPoints[index - 1].x,
      originalPoints[index].z - originalPoints[index - 1].z,
    );
    distances.push(distanceAlong);
  }
  return extendedPoints.map((_, index) => {
    const clampedIndex = Math.max(0, Math.min(index - 1, distances.length - 1));
    return sampleRoadElevation(profile, distances[clampedIndex]);
  });
}

export function buildBuildingGeometry(building: WorldBuilding): THREE.ExtrudeGeometry {
  const points = building.rings[0] ?? [];
  const shape = new THREE.Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(3, building.height), bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function buildRoofGeometry(building: WorldBuilding): THREE.ShapeGeometry {
  return areaGeometry(building.rings[0] ?? [], building.height + resolveRoofStyle(building).capLift);
}


function areaGeometry(ring: Array<{ x: number; z: number }>, y: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  ring.forEach((point, index) => index === 0 ? shape.moveTo(point.x, -point.z) : shape.lineTo(point.x, -point.z));
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}

/**
 * A ring of quads running inward from a polygon's own boundary, with a colour and an
 * opacity at each edge of the band. Both water bands are this shape; the only differences
 * are how far in they reach and what they fade between.
 *
 * **The width is clamped to what the polygon can actually hold.** `insetRing` miters each
 * corner inward but has no notion of the ring running out of interior, so an inset wider
 * than the polygon's own half-width folds the inner ring inside-out — the band then draws
 * back over itself, and on the shallows band (which reaches 7m in, not 1.6m) that is the
 * difference between a shelving beach and a bright crease down the middle of every stream.
 * Bounding-box half-extent is the cheap bound: it is an over-estimate of the true inradius,
 * so the 0.85 factor covers the gap for anything but a pathological spiral.
 */
function buildInwardBand(
  ring: LocalPoint[],
  y: number,
  width: number,
  outer: { color: THREE.Color; alpha: number },
  inner: { color: THREE.Color; alpha: number },
): THREE.BufferGeometry | null {
  const count = ring.length;
  if (count < 3) return null;
  const bounds = ringBounds(ring);
  const halfExtent = Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
  const effective = Math.min(width, halfExtent * 0.85);
  if (!(effective > 0.05)) return null;

  // Inward offset via the same correct, winding-aware inset utility used for
  // building/park mounds (terrain.ts's insetRing), rather than a bespoke per-vertex
  // centroid-direction hack — that hack degenerates on concave rings, where "toward the
  // centroid" is not the same direction as "into the polygon" at a reflex vertex.
  const insetPoints = insetRing(ring, effective);

  const positions = new Float32Array(count * 2 * 3);
  // Four components, not three: the shallows band fades to fully transparent at its inner
  // edge rather than to another colour, which is the only way a 7m band can end without
  // drawing a seam across open water. Alpha 1 throughout leaves a band exactly as it was.
  const colors = new Float32Array(count * 2 * 4);
  const writeVertex = (offset: number, point: LocalPoint, tint: { color: THREE.Color; alpha: number }) => {
    positions[offset * 3] = point.x;
    positions[offset * 3 + 1] = y;
    positions[offset * 3 + 2] = point.z;
    colors[offset * 4] = tint.color.r;
    colors[offset * 4 + 1] = tint.color.g;
    colors[offset * 4 + 2] = tint.color.b;
    colors[offset * 4 + 3] = tint.alpha;
  };
  ring.forEach((point, index) => writeVertex(index, point, outer));
  insetPoints.forEach((point, index) => writeVertex(count + index, point, inner));

  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    // Quad between this edge's outer pair and its inner pair, as two triangles.
    // Winding is drawn both ways by the DoubleSide material this pairs with, since the
    // source ring's own winding isn't guaranteed either.
    indices.push(index, count + index, count + next, index, count + next, next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Stands a batch of street furniture on the surface under each item.
 *
 * Every batch but the lamps was planted at `y = 0` regardless of what was underneath, so a
 * shelter beside a landuse mound stood knee-deep in the bank and a post box on a raised
 * verge was buried to the slot. `y = 0` is the *base* ground plane, not the ground.
 *
 * A post-step rather than something the generators do themselves, which is the opposite of
 * how the lamps handle it — deliberately. A lamp's height changes its *horizontal*
 * placement too (a deck lamp moves inboard of the kerb and skips the pavement-occupancy
 * check), so it has to be decided during generation. Nothing here works that way: where a
 * shelter goes is a question about roads and footprints, and how high it stands is a
 * question about the ground, and keeping the two apart leaves three generators that are
 * still purely about the map.
 *
 * **Road decks are deliberately not consulted.** The obvious way to add them is a point
 * query against the elevation profiles, and that is wrong: a point query answers with the
 * *highest* deck covering a point, so a shelter on the street running under a viaduct
 * would be hoisted onto the viaduct. Doing it properly needs each placement to carry the
 * road and the distance along it that it came from, the way `LampSurface.deckHeightAlong`
 * is keyed — which none of these three generators track today.
 */
function standOnGround<T extends { x: number; z: number }>(
  items: T[],
  heightAt: (x: number, z: number) => number,
): Array<T & { y: number }> {
  return items.map((item) => ({ ...item, y: heightAt(item.x, item.z) }));
}

/** How wide the foam band reaches in from a water polygon's own boundary, in meters. */
const SHORELINE_WIDTH = 1.6;
/** Foam is near-white at the true shoreline, fading to the water's own tint at the
 * band's inner edge so it blends into the plain surface mesh underneath rather than
 * needing its own alpha channel. */
const SHORELINE_FOAM_COLOR = new THREE.Color(0xeaf6f5);
const SHORELINE_WATER_COLOR = new THREE.Color(0x2d7186);

/**
 * A band of foam-to-water-tint vertex colour running just inside a water polygon's own
 * boundary — replaces the hard edge a flat, uniformly-tinted surface reads as where it
 * meets land. Offsets *inward* only, never out over land: the boundary ring alone is
 * the shoreline, so an outward band would draw foam on top of the ground/park mesh
 * instead of the water it belongs to. Returns null for a ring too small to form a
 * polygon at all.
 */
export function buildShorelineGeometry(ring: LocalPoint[], y: number, width = SHORELINE_WIDTH): THREE.BufferGeometry | null {
  return buildInwardBand(
    ring, y, width,
    { color: SHORELINE_FOAM_COLOR, alpha: 1 },
    { color: SHORELINE_WATER_COLOR, alpha: 1 },
  );
}

/**
 * The shallows: a wash of pale bottom-colour running in from the shore, fading to nothing
 * exactly where the water stops being wadeable.
 *
 * This is what makes the depth model *visible*. `waterIndex.ts` shelves the bed from
 * nothing at the boundary to `WATER_OPEN_DEPTH` over `WATER_SHELF_WIDTH`, and everything
 * that moves reads that — but nothing drew it, so a bay was one uniform blue slab right up
 * to the beach and the only cue that the water got deeper was the player suddenly
 * swimming. The band uses the same shelf width on purpose: where the wash ends is where
 * you can no longer stand.
 *
 * Drawn *over* the surface rather than under it, which is the wrong way round physically
 * and the right way round here. This water is nearly opaque looking down (see the
 * view-angle tint), so a band underneath it would barely show through; a pale tint at low
 * alpha on top blends to almost exactly what shallow water over a light bottom looks like,
 * without the lake bed geometry this flat world has nowhere to put.
 */
const SHALLOWS_COLOR = new THREE.Color(0x9fb8a8);
const SHALLOWS_ALPHA = 0.5;

export function buildShallowsGeometry(
  ring: LocalPoint[],
  y: number,
  width = WATER_SHELF_WIDTH,
): THREE.BufferGeometry | null {
  return buildInwardBand(
    ring, y, width,
    { color: SHALLOWS_COLOR, alpha: SHALLOWS_ALPHA },
    // Fades out entirely rather than into the water's tint: the band's inner edge is in
    // open water, where any colour at all would read as a seam ringing the polygon.
    { color: SHALLOWS_COLOR, alpha: 0 },
  );
}

/**
 * Buildings/facades get a noticeably *shorter* draw distance than roads/water/terrain,
 * on purpose: they're both the actual performance cost driver (up to ~1500 buildings,
 * each an instanced wall batch with a non-trivial fragment shader) and the least
 * jarring thing to lose early — a distant building fading into fog a bit sooner reads
 * as normal, while a river or a main road disappearing partway down the block reads as
 * broken. Both are well inside the fog-hidden distance (~1600m) so neither cutoff itself
 * is what a driver actually sees; they bound *how much geometry gets built/drawn* to
 * produce that same foggy horizon.
 */
export const MAX_BUILDING_DRAW_DISTANCE = 500;
export const MAX_TERRAIN_DRAW_DISTANCE = 1_200;

/** Past this fraction of the (budget-scaled) building draw distance, a facade's batched
 * instanced walls buy nothing over the plain extruded box: at that range a building is a
 * few pixels of silhouette, not somewhere a window grid or shopfront reads. Buildings out
 * here skip facade-record building entirely rather than building and then discarding it. */
const FACADE_DETAIL_DISTANCE_FRACTION = 0.6;

function withinDrawDistance(point: LocalPoint, anchorX: number, anchorZ: number, maxDistance: number): boolean {
  const dx = point.x - anchorX;
  const dz = point.z - anchorZ;
  return dx * dx + dz * dz <= maxDistance * maxDistance;
}

/** True if any point of a road/area's geometry falls within maxDistance — a polyline or
 * polygon can span the cutoff, so (unlike a building) checking a single point isn't
 * enough to avoid clipping something that's still partly in range. */
function anyPointWithinDrawDistance(points: LocalPoint[], anchorX: number, anchorZ: number, maxDistance: number): boolean {
  return points.some((point) => withinDrawDistance(point, anchorX, anchorZ, maxDistance));
}

/**
 * A single untessellated quad spanning tens of kilometers (as ground/water fallback
 * previously were) breaks the logarithmic depth buffer: depth is written per-vertex
 * then interpolated *linearly* across a huge triangle, which doesn't match the log
 * curve and shows up as dense horizontal banding/z-fighting stripes. The camera's far
 * plane (2500) and fog already hide anything past a few thousand units, so the plane
 * only needs to reach just beyond that — segmented finely enough that each triangle's
 * depth range stays small and the linear-interpolation error stays sub-pixel.
 */
const GROUND_PLANE_SIZE = 6_000;
const GROUND_PLANE_SEGMENTS = 96;

function groundPlaneGeometry(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(GROUND_PLANE_SIZE, GROUND_PLANE_SIZE, GROUND_PLANE_SEGMENTS, GROUND_PLANE_SEGMENTS);
}

/**
 * One entry per landuse/leisure/landcover class the data sources actually emit — the
 * OpenMapTiles `landcover` and `landuse` layers and OSM's `landuse`/`leisure` tags,
 * which between them cover far more ground types than the handful this used to know
 * about. Anything unrecognised falls back to a neutral green; the point of naming this
 * many is that a beach, a farm field, a rail yard and a sports pitch stop all being the
 * same shade of grass.
 */
const LANDUSE_COLORS: Record<string, number> = {
  park: 0x557b55, garden: 0x64885d, grass: 0x6f9363, meadow: 0x739363,
  forest: 0x416b4b, wood: 0x416b4b, scrub: 0x5b7449, heath: 0x7f8355,
  recreation_ground: 0x66865c, village_green: 0x6c9060, dog_park: 0x6a8b5e,
  cemetery: 0x647662, grave_yard: 0x647662, allotments: 0x71865e,
  orchard: 0x5f8449, vineyard: 0x6d854a, farmland: 0x9d9a5e, farmyard: 0x94886a,
  pitch: 0x4f8158, track: 0x8a6a4f, golf_course: 0x5d8a55, playground: 0x7c8a63,
  stadium: 0x6f7f68, sports_centre: 0x6f7f68,
  wetland: 0x5c7360, marsh: 0x5c7360, sand: 0xc4b489, beach: 0xc9bb92,
  bare_rock: 0x8d8b83, scree: 0x8b8880, quarry: 0x8b8175, brownfield: 0x8a8472,
  residential: 0x9b9b86, commercial: 0x958b80, retail: 0x9d8b80,
  industrial: 0x88847d, railway: 0x777873, military: 0x87866d,
  school: 0x9a9a83, university: 0x9a9a83, hospital: 0xa19790,
  cemetery_wall: 0x647662, ice: 0xd8e4e8, glacier: 0xd8e4e8,
};

const NEUTRAL_LANDUSE_COLOR = 0x78906a;

/** Small deterministic shade drift per polygon. Real OSM data blankets whole
 * neighbourhoods in a single landuse class, and without this those read as one
 * enormous flat sheet of colour with polygon seams the only thing breaking it up. */
const LANDUSE_TINT_RANGE = 0.055;

function landuseColor(area: WorldArea): THREE.Color {
  const base = LANDUSE_COLORS[area.kind] ?? NEUTRAL_LANDUSE_COLOR;
  const color = new THREE.Color(base);
  const drift = (stableNumber(area.id) - 0.5) * 2 * LANDUSE_TINT_RANGE;
  return color.offsetHSL(drift * 0.35, drift * 0.6, drift);
}

function createObjectInstances(data: WorldData, groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'world:street-furniture';
  // `post_box` is deliberately absent: mapped boxes are built by createMailboxInstances
  // alongside the generated ones, so a surveyed box and a generated one on the next
  // street are the same object rather than a detailed model beside a mustard slab.
  const definitions = [
    { kinds: ['bench'], geometry: new THREE.BoxGeometry(1.8, 0.18, 0.48), color: 0x76563b, y: 0.62 },
    { kinds: ['bench'], part: 'legs', geometry: new THREE.BoxGeometry(1.4, 0.53, 0.32), color: 0x343c3a, y: 0.265 },
    { kinds: ['bench'], part: 'back', geometry: new THREE.BoxGeometry(1.8, 0.4, 0.1).translate(0, 0, -0.22), color: 0x76563b, y: 0.88 },
    { kinds: ['waste_basket'], part: 'lid', geometry: new THREE.CylinderGeometry(0.27, 0.27, 0.09, 10), color: 0x202d29, y: 0.845 },
    { kinds: ['fountain', 'drinking_water'], part: 'water', geometry: new THREE.CylinderGeometry(0.97, 0.97, 0.025, 24), color: 0x66bad0, y: 0.565 },
    { kinds: ['fountain', 'drinking_water'], part: 'jet', geometry: new THREE.CylinderGeometry(0.035, 0.09, 0.9, 8), color: 0xa5e4ed, y: 1.02 },
    { kinds: ['street_lamp'], geometry: new THREE.CylinderGeometry(0.06, 0.1, 4.2, 6), color: 0x32383a, y: 2.1 },
    { kinds: ['artwork', 'statue', 'sculpture'], geometry: new THREE.CylinderGeometry(0.35, 0.5, 1.8, 8), color: 0x817b6d, y: 0.9 },
    { kinds: ['waste_basket'], geometry: new THREE.CylinderGeometry(0.24, 0.19, 0.8, 8), color: 0x3f4c46, y: 0.4 },
    { kinds: ['bicycle_parking'], geometry: new THREE.TorusGeometry(0.34, 0.035, 5, 10, Math.PI), color: 0x6d737a, y: 0.36 },
    { kinds: ['fountain', 'drinking_water'], geometry: new THREE.CylinderGeometry(1.1, 1.25, 0.55, 12), color: 0x8d8b83, y: 0.28 },
    { kinds: ['flagpole', 'mast'], geometry: new THREE.CylinderGeometry(0.05, 0.08, 8, 6), color: 0xc9ccce, y: 4 },
  ] as const;
  for (const definition of definitions) {
    const objects = data.objects.filter(object => definition.kinds.includes(object.kind as never));
    if (!objects.length) {
      definition.geometry.dispose();
      continue;
    }
    const material = new THREE.MeshStandardMaterial({ color: definition.color, roughness: 0.85 });
    const mesh = new THREE.InstancedMesh(definition.geometry, material, objects.length);
    mesh.name = `world:objects:${definition.kinds[0]}${'part' in definition ? ':' + definition.part : ''}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    objects.forEach((object, index) => {
      matrix.makeTranslation(object.point.x, groundAt(object.point.x, object.point.z) + definition.y, object.point.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.userData[INSPECTION_USER_DATA_KEY] = objects.map((object) => ({
      id: object.id,
      category: 'object',
      title: object.kind.replaceAll('_', ' '),
      source: data.source,
      properties: sanitizeInspectionProperties({ kind: object.kind, ...object.properties }),
    } satisfies WorldInspectionRecord));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }
  return group;
}

/** Hard cap on procedurally-placed lamps per world snapshot, independent of how dense
 * the underlying road network is — keeps a downtown grid from spawning thousands of
 * instances just because LAMP_SPACING packs them tightly along many short ways. */

/** Foliage palette endpoints, mixed per instance by a tree's own `tint` so a stand
 * reads as many trees rather than one repeated model. Conifers stay dark and blue-green,
 * broadleaves range from spring yellow-green to deep summer green. */
const NEEDLELEAF_FOLIAGE = [0x24402f, 0x35583a] as const;
const BROADLEAF_FOLIAGE = [0x4d7238, 0x6e8f42] as const;
const TRUNK_COLOR = 0x4a3a2c;

/**
 * Two crown silhouettes and one trunk, each an InstancedMesh with per-instance colour —
 * four draw calls for a whole forest. Crowns are deliberately low-poly: at the densities
 * generateTrees produces, a tree is a few pixels of silhouette for all but the nearest
 * dozen, and the shape is what reads, not the tessellation.
 */
function createTreeInstances(trees: TreePlacement[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'world:trees';
  if (!trees.length) return group;

  const needleleaf = trees.filter((tree) => tree.kind === 'needleleaf');
  const broadleaf = trees.filter((tree) => tree.kind === 'broadleaf');

  // Both crown geometries are built as a unit shape with its base (cone) or centre
  // (sphere) at the origin, so one instance matrix can carry position, size and yaw.
  const coneGeometry = new THREE.ConeGeometry(1, 1, 7);
  coneGeometry.translate(0, 0.5, 0);
  const sphereGeometry = new THREE.SphereGeometry(1, 7, 5);
  const trunkGeometry = new THREE.CylinderGeometry(1, 1.25, 1, 5);
  trunkGeometry.translate(0, 0.5, 0);

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const from = new THREE.Color();
  const to = new THREE.Color();

  const addCrowns = (
    name: string,
    geometry: THREE.BufferGeometry,
    batch: TreePlacement[],
    palette: readonly [number, number],
    /** Fraction of total height the crown's own vertical extent occupies. */
    crownHeight: number,
    /** Height fraction the crown is centred at (spheres) or starts at (cones). */
    baseAt: number,
  ) => {
    if (!batch.length) {
      geometry.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ roughness: 0.92, flatShading: true }),
      batch.length,
    );
    mesh.name = `world:trees:${name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    from.setHex(palette[0]);
    to.setHex(palette[1]);
    batch.forEach((tree, index) => {
      matrix.makeRotationY(tree.yaw);
      matrix.scale(new THREE.Vector3(tree.radius, tree.height * crownHeight, tree.radius));
      matrix.setPosition(tree.x, tree.y + tree.height * baseAt, tree.z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, color.copy(from).lerp(to, tree.tint));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  };

  addCrowns('needleleaf', coneGeometry, needleleaf, NEEDLELEAF_FOLIAGE, 0.82, 0.18);
  addCrowns('broadleaf', sphereGeometry, broadleaf, BROADLEAF_FOLIAGE, 0.24, 0.7);

  const trunks = new THREE.InstancedMesh(
    trunkGeometry,
    new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 0.95 }),
    trees.length,
  );
  trunks.name = 'world:trees:trunks';
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  trees.forEach((tree, index) => {
    // A conifer's cone comes most of the way down, so only a stub shows; a broadleaf
    // crown floats and needs a real trunk under it.
    const trunkTop = tree.height * (tree.kind === 'needleleaf' ? 0.2 : 0.62);
    const trunkRadius = Math.max(0.06, tree.radius * 0.09);
    matrix.makeRotationY(tree.yaw);
    matrix.scale(new THREE.Vector3(trunkRadius, trunkTop, trunkRadius));
    matrix.setPosition(tree.x, tree.y, tree.z);
    trunks.setMatrixAt(index, matrix);
  });
  trunks.instanceMatrix.needsUpdate = true;
  group.add(trunks);

  return group;
}

/** A built lamp-post batch, plus the one call that switches the lamps on. */
export interface StreetLightBatch {
  group: THREE.Group;
  /** 0 by day, 1 at full night. */
  setNight(nightFactor: number): void;
}

/** Lens colour with the lamps off and full on. A sodium lamp is a dull grey-brown lump
 * of glass in daylight, and painting it the lit colour around the clock was the one thing
 * that gave away that these are not lights at all but a baked stand-in for them. */
const BULB_DARK = 0x6f6a5e;
const BULB_LIT = 0xffd9a0;

function createStreetLightInstances(lights: LampPlacement[]): StreetLightBatch {
  const group = new THREE.Group();
  group.name = 'world:street-lights';
  if (!lights.length) return { group, setNight: () => {} };

  const poleHeight = 4.6;
  const poleGeometry = new THREE.CylinderGeometry(0.045, 0.09, poleHeight, 6);
  poleGeometry.translate(0, poleHeight / 2, 0);
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x2c2f31, roughness: 0.6, metalness: 0.35 });
  const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, lights.length);
  poles.name = 'world:street-lights:poles';
  poles.castShadow = true;
  poles.receiveShadow = true;

  // A plain MeshBasicMaterial bulb is unlit by the scene, which is what a lamp lens
  // wants — cheap and legible from a moving car, unlike a real point light per post
  // (hundreds of those would blow the dynamic-light budget). Its colour is driven from
  // the time of day instead, so the light is baked rather than simulated and the lamps
  // still come on at dusk. See setNight.
  const bulbGeometry = new THREE.SphereGeometry(0.16, 8, 6);
  const bulbMaterial = new THREE.MeshBasicMaterial({ color: BULB_DARK });
  const bulbs = new THREE.InstancedMesh(bulbGeometry, bulbMaterial, lights.length);
  bulbs.name = 'world:street-lights:bulbs';
  // Neither flag belongs on a lamp lens. It is the light source, so casting put a hard
  // 16cm shadow blob under every post at a low sun; and MeshBasicMaterial is unlit by
  // definition, so receiving was a shadow-map lookup per pixel that could never change
  // the result.
  bulbs.castShadow = false;
  bulbs.receiveShadow = false;

  const matrix = new THREE.Matrix4();
  lights.forEach((lamp, index) => {
    matrix.makeRotationY(lamp.yaw);
    // The pole geometry is translated so its own origin is its base, so the placement's
    // surface height *is* the instance's y — on a deck as much as on the ground.
    matrix.setPosition(lamp.x, lamp.y, lamp.z);
    poles.setMatrixAt(index, matrix);
    matrix.setPosition(lamp.x, lamp.y + poleHeight, lamp.z);
    bulbs.setMatrixAt(index, matrix);
  });
  const records = lights.map((lamp, index) => ({
    id: `runtime:street-light:${index}:${lamp.x.toFixed(2)}:${lamp.z.toFixed(2)}`,
    category: 'object',
    title: 'Street light',
    source: 'runtime',
    properties: { kind: 'street_light' },
  } satisfies WorldInspectionRecord));
  poles.userData[INSPECTION_USER_DATA_KEY] = records;
  bulbs.userData[INSPECTION_USER_DATA_KEY] = records;
  poles.instanceMatrix.needsUpdate = true;
  bulbs.instanceMatrix.needsUpdate = true;

  group.add(poles, bulbs);
  const dark = new THREE.Color(BULB_DARK);
  const lit = new THREE.Color(BULB_LIT);
  return {
    group,
    setNight(nightFactor: number) {
      // Lamps strike over dusk rather than snapping on, and the curve is deliberately
      // steep at the start: a street goes from unlit to lit over a few minutes of
      // in-game evening, not gradually across the whole afternoon.
      const level = Math.min(1, Math.max(0, nightFactor) * 1.8);
      bulbMaterial.color.copy(dark).lerp(lit, level);
    },
  };
}

/** A built bus-shelter batch, plus the one call that switches its tubes on. */
export interface BusStopBatch {
  group: THREE.Group;
  /** 0 by day, 1 at full night. */
  setNight(nightFactor: number): void;
}

/** Shelter dimensions, in meters: local +X runs along the kerb, local +Z is the open
 * side facing the road. The roof is a half-cylinder of radius DEPTH/2, so the arch
 * springs exactly from the tops of the side walls. */
const SHELTER_WIDTH = 4;
const SHELTER_DEPTH = 1.7;
/** Top of the glass, and the springing line of the arch. */
const SHELTER_WALL_TOP = 2.35;
const SHELTER_BAR_RADIUS = 0.055;

/** Fluorescent tube colour off and on. Off it is the dead grey-green of unlit phosphor,
 * which is what keeps a shelter from reading as lit at noon; on it is the cool,
 * slightly green-cast white that gives a real bus stop its clinical night look. */
const TUBE_DARK = 0x8a9088;
const TUBE_LIT = 0xf3fff2;

/**
 * Glass-walled shelters: three glazed panels held between metal corner bars, an arched
 * roof over them, a wooden bench inside, and a baked fluorescent tube under the apex.
 *
 * Every part is one InstancedMesh across the whole batch, so a district's worth of
 * shelters costs seven draw calls rather than seven per shelter. Parts that repeat
 * within a shelter (corner bars, side panels, bench legs) take several instances each,
 * with their local offset rotated into place by the shelter's own yaw.
 */
function createBusStopInstances(stops: BusStopPlacement[]): BusStopBatch {
  const group = new THREE.Group();
  group.name = 'world:bus-stops';
  if (!stops.length) return { group, setNight: () => {} };

  const halfWidth = SHELTER_WIDTH / 2;
  const halfDepth = SHELTER_DEPTH / 2;
  const arch = halfDepth;

  const matrix = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const rotation = new THREE.Matrix4();
  /** Places one part instance: `local` is its offset/orientation inside the shelter,
   * which the shelter's yaw and world position then carry into the scene. */
  const place = (mesh: THREE.InstancedMesh, index: number, stop: BusStopPlacement, part: THREE.Matrix4) => {
    rotation.makeRotationY(stop.yaw);
    matrix.multiplyMatrices(rotation, part);
    // elements[13] is the part's own height inside the shelter; the shelter's own base is
    // whatever surface it was stood on (see standOnGround), and was previously always 0.
    matrix.setPosition(
      stop.x + matrix.elements[12],
      (stop.y ?? 0) + matrix.elements[13],
      stop.z + matrix.elements[14],
    );
    mesh.setMatrixAt(index, matrix);
  };

  const addPart = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    perStop: number,
    offsets: (stop: BusStopPlacement, slot: number) => THREE.Matrix4,
    shadows = true,
  ) => {
    const mesh = new THREE.InstancedMesh(geometry, material, stops.length * perStop);
    mesh.name = `world:bus-stops:${name}`;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    stops.forEach((stop, stopIndex) => {
      for (let slot = 0; slot < perStop; slot += 1) {
        place(mesh, stopIndex * perStop + slot, stop, offsets(stop, slot));
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return mesh;
  };

  const metal = new THREE.MeshStandardMaterial({ color: 0x585e62, roughness: 0.38, metalness: 0.8 });
  // Transparent, not MeshPhysicalMaterial with transmission: transmission is a second
  // render pass of everything behind the panel, and at these counts that is a whole
  // extra pass over the city per shelter. A cheap tinted alpha plus a strong specular
  // is what reads as glass at driving speed anyway.
  const glass = new THREE.MeshStandardMaterial({
    color: 0xa8c4cc,
    roughness: 0.06,
    metalness: 0.1,
    transparent: true,
    opacity: 0.24,
    side: THREE.DoubleSide,
    // Glass in front of glass sorted wrongly against itself far more often than it
    // showed anything worth the sorting: the panels are a hint of a surface, and
    // writing depth would also punch the bench and the tube behind them out of the
    // frame.
    depthWrite: false,
  });
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a39, roughness: 0.82 });
  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x9aa2a6,
    roughness: 0.45,
    metalness: 0.55,
    side: THREE.DoubleSide,
  });
  const tubeMaterial = new THREE.MeshBasicMaterial({ color: TUBE_DARK });

  // Four corner bars, running the full height and carrying the roof.
  const barGeometry = new THREE.CylinderGeometry(SHELTER_BAR_RADIUS, SHELTER_BAR_RADIUS, SHELTER_WALL_TOP, 8);
  barGeometry.translate(0, SHELTER_WALL_TOP / 2, 0);
  const barSlots = [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [-halfWidth, halfDepth], [halfWidth, halfDepth],
  ] as const;
  addPart('bars', barGeometry, metal, 4, (_stop, slot) => {
    const [x, z] = barSlots[slot];
    return local.makeTranslation(x, 0, z);
  });

  // Glazing sits just inside the bars so the bars read as holding it, and stops short
  // of the ground and the roof the way a real panel sits in its frame.
  const glassHeight = SHELTER_WALL_TOP - 0.3;
  const glassY = 0.18 + glassHeight / 2;
  const backGlass = new THREE.BoxGeometry(SHELTER_WIDTH - SHELTER_BAR_RADIUS * 2, glassHeight, 0.03);
  addPart('glass-back', backGlass, glass, 1, () => local.makeTranslation(0, glassY, -halfDepth), false);

  const sideGlass = new THREE.BoxGeometry(SHELTER_DEPTH - SHELTER_BAR_RADIUS * 2, glassHeight, 0.03);
  addPart('glass-sides', sideGlass, glass, 2, (_stop, slot) => {
    local.makeRotationY(Math.PI / 2);
    local.setPosition(slot === 0 ? -halfWidth : halfWidth, glassY, 0);
    return local;
  }, false);

  // Half-cylinder shell, axis along the kerb. Theta 0..PI keeps the shell on the +X side
  // of the cylinder's own cross-section, and rotating +90 degrees about Z lays the
  // cylinder's axis onto X while turning that +X radius into +Y — so the arc springs
  // from the wall tops and its apex points up. (Rotating -90 instead hangs the same
  // shell downwards as a trough, which is what it did first.) Open-ended keeps the two
  // end caps out of the silhouette: an arched roof is a sheet, not a solid.
  const roofGeometry = new THREE.CylinderGeometry(arch, arch, SHELTER_WIDTH + 0.24, 14, 1, true, 0, Math.PI);
  roofGeometry.rotateZ(Math.PI / 2);
  roofGeometry.translate(0, SHELTER_WALL_TOP, 0);
  addPart('roof', roofGeometry, roofMaterial, 1, () => local.makeTranslation(0, 0, 0));

  // Baked light, not a real one: a point light per shelter would blow the dynamic-light
  // budget the same way per-lamp lights do. The tube is unlit geometry whose colour is
  // driven from the time of day — see setNight.
  const tubeGeometry = new THREE.BoxGeometry(SHELTER_WIDTH * 0.62, 0.07, 0.1);
  // Slung below the apex rather than pressed into it: at the crown the arch itself hides
  // the tube from anyone standing at the kerb, which is the one place it has to be seen.
  addPart('tube', tubeGeometry, tubeMaterial, 1, () => local.makeTranslation(0, SHELTER_WALL_TOP + arch * 0.3, 0), false);

  // Bench: a wooden slab on two metal legs, set against the back wall so it faces out
  // through the open side.
  const seatZ = -halfDepth + 0.42;
  const seatGeometry = new THREE.BoxGeometry(SHELTER_WIDTH * 0.72, 0.08, 0.4);
  addPart('bench-seat', seatGeometry, wood, 1, () => local.makeTranslation(0, 0.46, seatZ));
  const backrestGeometry = new THREE.BoxGeometry(SHELTER_WIDTH * 0.72, 0.16, 0.05);
  addPart('bench-back', backrestGeometry, wood, 1, () => local.makeTranslation(0, 0.78, seatZ - 0.2));
  const legGeometry = new THREE.BoxGeometry(0.05, 0.46, 0.34);
  legGeometry.translate(0, 0.23, 0);
  addPart('bench-legs', legGeometry, metal, 2, (_stop, slot) =>
    local.makeTranslation(slot === 0 ? -SHELTER_WIDTH * 0.28 : SHELTER_WIDTH * 0.28, 0, seatZ));

  const records = stops.map((stop, index) => ({
    id: `runtime:bus-stop:${index}:${stop.x.toFixed(2)}:${stop.z.toFixed(2)}`,
    category: 'object',
    title: 'Bus stop',
    source: 'runtime',
    properties: { kind: 'bus_stop' },
  } satisfies WorldInspectionRecord));
  // One record per shelter, but the parts carry different instance counts, so each mesh
  // maps its own instance index back onto the shelter it belongs to.
  for (const child of group.children) {
    if (!(child instanceof THREE.InstancedMesh)) continue;
    const perStop = child.count / stops.length;
    child.userData[INSPECTION_USER_DATA_KEY] = Array.from(
      { length: child.count },
      (_value, index) => records[Math.floor(index / perStop)],
    );
  }

  const dark = new THREE.Color(TUBE_DARK);
  const lit = new THREE.Color(TUBE_LIT);
  return {
    group,
    setNight(nightFactor: number) {
      // Same curve as the street lamps, so a shelter and the post beside it come on
      // together instead of drifting apart across dusk.
      const level = Math.min(1, Math.max(0, nightFactor) * 1.8);
      tubeMaterial.color.copy(dark).lerp(lit, level);
    },
  };
}

/** Post box dimensions, in meters: local +Z is the slot side, facing the pavement. */
const MAILBOX_WIDTH = 0.5;
const MAILBOX_DEPTH = 0.34;
const MAILBOX_BODY_HEIGHT = 0.62;
/** Height of the underside of the body — a posting slot has to be reachable standing up,
 * not crouching, so the box hangs high on its post. */
const MAILBOX_BODY_BASE = 0.82;

/**
 * Swedish street post boxes: a yellow body with a rounded lid and a dark posting slot,
 * on a single grey post, with a small collection-times plate on the front.
 *
 * Five InstancedMeshes for the whole batch, same discipline as the shelters — a
 * district's boxes cost five draw calls, not five each.
 */
function createMailboxInstances(boxes: MailboxPlacement[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'world:mailboxes';
  if (!boxes.length) return group;

  const matrix = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const rotation = new THREE.Matrix4();
  const addPart = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    offset: () => THREE.Matrix4,
  ) => {
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    mesh.name = `world:mailboxes:${name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    boxes.forEach((box, index) => {
      rotation.makeRotationY(box.yaw);
      matrix.multiplyMatrices(rotation, offset());
      matrix.setPosition(box.x + matrix.elements[12], (box.y ?? 0) + matrix.elements[13], box.z + matrix.elements[14]);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return mesh;
  };

  // Posten yellow, matte: a post box is painted steel that has stood outdoors for years,
  // so the roughness is high and there is no metalness left to speak of.
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c218, roughness: 0.62, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x50555a, roughness: 0.5, metalness: 0.6 });
  const slotMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.9 });

  const postGeometry = new THREE.CylinderGeometry(0.045, 0.05, MAILBOX_BODY_BASE, 8);
  postGeometry.translate(0, MAILBOX_BODY_BASE / 2, 0);
  addPart('post', postGeometry, metal, () => local.makeTranslation(0, 0, 0));

  const bodyGeometry = new THREE.BoxGeometry(MAILBOX_WIDTH, MAILBOX_BODY_HEIGHT, MAILBOX_DEPTH);
  addPart('body', bodyGeometry, yellow, () =>
    local.makeTranslation(0, MAILBOX_BODY_BASE + MAILBOX_BODY_HEIGHT / 2, 0));

  // Half-cylinder lid, axis across the box, so rain runs off the front. Same rotateZ
  // trick as the shelter roof: theta 0..PI on +X, rotated onto +Y.
  const lidGeometry = new THREE.CylinderGeometry(
    MAILBOX_DEPTH / 2, MAILBOX_DEPTH / 2, MAILBOX_WIDTH, 12, 1, false, 0, Math.PI);
  lidGeometry.rotateZ(Math.PI / 2);
  addPart('lid', lidGeometry, yellow, () =>
    local.makeTranslation(0, MAILBOX_BODY_BASE + MAILBOX_BODY_HEIGHT, 0));

  // Slot and plate stand a millimetre proud of the front face rather than flush with it:
  // coplanar faces z-fight, and at this size the offset is invisible.
  const slotGeometry = new THREE.BoxGeometry(MAILBOX_WIDTH * 0.66, 0.045, 0.012);
  addPart('slot', slotGeometry, slotMaterial, () =>
    local.makeTranslation(0, MAILBOX_BODY_BASE + MAILBOX_BODY_HEIGHT * 0.74, MAILBOX_DEPTH / 2 + 0.001));

  const plateGeometry = new THREE.BoxGeometry(MAILBOX_WIDTH * 0.5, 0.14, 0.01);
  addPart('plate', plateGeometry, metal, () =>
    local.makeTranslation(0, MAILBOX_BODY_BASE + MAILBOX_BODY_HEIGHT * 0.3, MAILBOX_DEPTH / 2 + 0.001));

  const records = boxes.map((box, index) => ({
    id: `runtime:mailbox:${index}:${box.x.toFixed(2)}:${box.z.toFixed(2)}`,
    category: 'object',
    title: 'Post box',
    source: 'runtime',
    properties: { kind: 'post_box' },
  } satisfies WorldInspectionRecord));
  // One instance per box in every part, so the instance index *is* the box index.
  for (const child of group.children) {
    if (!(child instanceof THREE.InstancedMesh)) continue;
    child.userData[INSPECTION_USER_DATA_KEY] = records;
  }
  return group;
}

/** Conservative bounding sphere around a building's whole extruded volume (footprint
 * ring expanded to its farthest corner from the centroid, up to its own height) —
 * cheap and deliberately loose (padded by 1m) rather than a tight fit, since it only
 * needs to answer "could any part of this building be on screen", not draw anything
 * itself. Reuses an already-computed centroid so callers that also need distance
 * filtering don't pay for it twice. */
function buildingBoundingSphere(building: WorldBuilding, centroid: LocalPoint): THREE.Sphere {
  const ring = building.rings[0] ?? [];
  let radius = 0;
  for (const point of ring) {
    radius = Math.max(radius, Math.hypot(point.x - centroid.x, point.z - centroid.z));
  }
  const halfHeight = Math.max(1, building.height) / 2;
  return new THREE.Sphere(
    new THREE.Vector3(centroid.x, halfHeight, centroid.z),
    Math.hypot(radius, halfHeight) + 1,
  );
}

/** How a rebuild is paid for. `incremental` stages the new world off-scene and slices
 * the work across frames (see buildScheduler) — the old world keeps drawing until the
 * new one is complete, so nothing blanks and no frame blocks. Everything else builds
 * straight through. */
export interface RebuildOptions {
  incremental?: boolean;
}

/** Counts carried by a world snapshot and the subset that the renderer actually built. */
export interface WorldBuildCounts {
  buildings: number;
  roads: number;
  water: number;
  parks: number;
  objects: number;
}

/** Serializable diagnostics for the world build currently running or most recently committed. */
export interface WorldBuildDiagnostics {
  generationId: number;
  estimatedSlices: number;
  finishedSlices: number;
  worstSliceMs: number;
  elapsedMs: number;
  complete: boolean;
  replacementCount: number;
  /** See `SLICE_HISTOGRAM_BOUNDS_MS` in `buildScheduler.ts` for bucket bounds. */
  sliceHistogram: number[];
  input: WorldBuildCounts;
  built: WorldBuildCounts;
}

export interface ThreeWorld {
  replace(data: WorldData, rebuild?: RebuildOptions): void;
  /** Advances an in-flight incremental rebuild by up to `budgetMs` of work. Returns
   * true while a rebuild is still outstanding. A no-op when nothing is building, so
   * the render loop can call it unconditionally every frame. */
  pump(budgetMs: number): boolean;
  /** True while an incremental rebuild is staged but not yet swapped in. */
  isBuilding(): boolean;
  /**
   * How far the in-flight build has got, 0..1, from slices completed against the
   * estimate made when it started (see estimateBuildSteps). Capped just short of 1
   * while work remains, and exactly 1 when nothing is building — a loading screen can
   * show it directly without special-casing the idle state.
   *
   * Approximate on purpose: the estimate is drawn from the whole snapshot rather than
   * the draw-distance-clipped subset the build actually walks, so it errs toward
   * finishing early. A bar that arrives ahead of schedule reads far better than one
   * that sits at 99% waiting.
   */
  buildProgress(): number;
  buildStage(): string;
  /** A copied point-in-time view of the scheduler and the counts already known to this world. */
  buildDiagnostics(): WorldBuildDiagnostics;
  setRenderOptions(options: RenderOptions): void;
  /** Recenters the ground/water fallback planes under (x, z) each frame — they're
   * sized just past the camera's far plane/fog, not the whole world, so they must
   * track the camera or the ground disappears once it drives away from the origin. */
  setAnchor(x: number, z: number): void;
  /**
   * Re-evaluates which buildings are actually visible (distance from the current
   * anchor + `camera`'s view frustum) and rebuilds only the buildings/roofs/facades
   * layer if the visible set changed — ground/parks/water/roads are untouched, so
   * this is cheap enough to call every frame. Water/roads/parks are deliberately
   * never frustum-culled here (they stay distance-only, at their own much larger
   * radius — see MAX_TERRAIN_DRAW_DISTANCE) so they keep drawing far down a straight
   * road even when the camera pans away momentarily. Pass `null` to skip the frustum
   * test and fall back to distance-only (matches the pre-frustum-culling behavior).
   */
  updateVisibleBuildings(camera: THREE.Camera | null, rebuild?: RebuildOptions): void;
  /**
   * 0..1 multiplier from a render budget (see renderBudget.ts) — scales the
   * effective facade instance cap and building draw distance down under sustained
   * frame drops, and the street-light count on the next surfaces rebuild. Always a
   * pull *inward* from the user's chosen RENDER_QUALITY tier, never past it (scale 1
   * reproduces exactly the unscaled tier). Never applied to water/roads/parks, which
   * keep drawing at their own fixed (larger) radius regardless of frame budget.
   */
  setRenderBudgetScale(scale: number): void;
  /**
   * Pushes the current time-of-day lighting into every custom ShaderMaterial this world
   * owns (facades, roads). Those shaders can't be reached by Three's own light uniforms,
   * so without this they'd keep the fixed, permanently-noon lighting they're born with
   * while the sky and every MeshStandardMaterial around them changed. The value is
   * cached and re-applied after each rebuild, so a material created between two
   * time-of-day changes is never left stale.
   */
  setSceneLighting(lighting: SceneLighting): void;
  /**
   * Advances everything in the world that animates on its own: the traffic signal cycle
   * and the neon flicker. `seconds` is a monotonic clock, not a delta — both are pure
   * functions of it, so a dropped frame, a pause or a rebuild changes nothing about what
   * they show, and nothing accumulates drift.
   *
   * Cheap enough for every frame: the signals repaint only the heads whose aspect
   * actually changed, and the signs are a single uniform write.
   */
  setAnimationTime(seconds: number): void;
  getInspectionTargets(): THREE.Object3D[];
  /**
   * Collision frames for everything standing on this world's pavements, for the physics
   * layer to give bodies to (see propRegistry.ts). A fresh array identity each rebuild,
   * which is how a caller knows the props it is holding refer to meshes that no longer
   * exist.
   */
  getProps(): WorldProp[];
  getBridgeColliders(): readonly BridgeCollider[];
  /**
   * The committed build's `RoadElevationProfile` per road id — see backlog item 8. This
   * is the single source both the rendered deck geometry (buildRoadGeometry) and the
   * physics ground-height callback (`svartaksiRuntime.tsx`) read, so a car never straddles a
   * gap between "where the deck is drawn" and "where the ground thinks it is standing".
   * Empty before the first roads-on build.
   */
  getRoadElevationProfiles(): Map<string, RoadElevationProfile>;
  dispose(): void;
}

/**
 * Items built between two yields of an incremental build.
 *
 * These were sized on the assumption that one slice would land comfortably under a
 * millisecond. Measured against a real snapshot they did not: a chunk of 64 landuse
 * polygons cost ~350ms and a chunk of 24 facade records ~175ms, which is a twenty-frame
 * stall in the middle of a build that exists precisely to avoid stalls — and on weaker
 * hardware, proportionally worse.
 *
 * They are small now, and deliberately so. `pump` keeps stepping until its millisecond
 * budget is spent, so a chunk smaller than the budget costs nothing on a fast machine
 * (several of them are simply coalesced into one pump) while putting a hard, low ceiling
 * on how long a single slice can run on a slow one. `estimateBuildSteps` reads these same
 * constants, so the progress readout follows automatically.
 */
const AREA_CHUNK = 8;
const FACADE_RECORD_CHUNK = 8;
const BUILDING_MESH_CHUNK = 16;

/** Holds the buildings, roofs and facades. Swapped as a unit so a rebuild of just this
 * layer never disturbs the much more expensive surfaces underneath it. */
const BUILDINGS_LAYER = 'world:buildings-layer';

/** Hard ceiling on buildings drawn at once, whatever the quality tier or how dense the
 * area is. Applied after a nearest-first sort, so the cap costs the farthest buildings
 * rather than an arbitrary slice of the source data. */
const MAX_VISIBLE_BUILDINGS = 1_500;

/** Four heads per junction, so this is 40 signalised junctions in view at once — still
 * more than the densest part of central Stockholm puts inside the building draw
 * distance, kept below the old cap so junctions read as sparse rather than wall-to-wall. */
const MAX_TRAFFIC_SIGNALS = 160;

/** Neon is one draw call however many there are, so this bounds the placement search and
 * the instance buffers rather than draw cost. */
const MAX_NEON_SIGNS = 400;

/** Shelters in one snapshot. Seven instanced parts each means the draw cost is fixed,
 * so this bounds instance-buffer size and the shadow-casting geometry, not draw calls. */
const MAX_BUS_STOPS = 48;

/** Post boxes in one snapshot. Higher than the shelter cap because residential streets
 * outnumber bus routes, and a box is a fifth of a shelter's geometry. */
const MAX_MAILBOXES = 64;

/**
 * Slices one full rebuild of `data` is expected to take, for the progress readout.
 * Mirrors the chunk sizes the two build jobs actually yield at — including the road
 * phase, which slices by accumulated polyline points rather than by road count, so the
 * estimate counts points there too. The stages that used to
 * run whole between two yields — trees, lamps, traffic signals, neon signs — now yield
 * inside themselves (see their `*Job` forms), so their slices are bounded like everything
 * else; the remaining single-yield stages (street furniture, the post boxes, the facade
 * batch) are the constant. Deliberately computed from the whole snapshot rather than the clipped
 * subset each stage walks — that subset isn't known until the job runs, and an
 * over-estimate is the harmless direction to be wrong in.
 */
/** Total polyline points across a road set — the unit the road phase now slices by,
 * so the progress estimate counts the same work the loop actually charges itself. */
function roadPointCount(roads: readonly WorldRoad[]): number {
  let points = 0;
  for (const road of roads) points += road.points.length;
  return points;
}

function estimateBuildSteps(data: WorldData): number {
  const buildings = Math.min(data.buildings.length, MAX_VISIBLE_BUILDINGS);
  return 8
    + Math.ceil(data.parks.length / AREA_CHUNK)
    + Math.ceil(data.water.length / AREA_CHUNK)
    + Math.ceil(roadPointCount(data.roads) / ROAD_GEOMETRY_POINT_BUDGET)
    + Math.ceil(buildings / FACADE_RECORD_CHUNK)
    + Math.ceil(buildings / BUILDING_MESH_CHUNK);
}

/**
 * Order-independent fingerprint of a visible set, used only to answer "is this the same
 * set as last time". Replaces sorting 1500 id strings and joining them into a ~60 KB
 * string four times a second: two commutative accumulators over an FNV hash of each id
 * give the same answer for the same set in any order, at a fraction of the cost. A
 * collision would delay one rebuild by a visibility tick, which is why cheapness wins
 * over cryptographic strength here.
 */
function visibleFingerprint(buildings: WorldBuilding[]): string {
  let sum = 0;
  let mix = 0;
  for (const building of buildings) {
    let hash = 2_166_136_261;
    const id = building.id;
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(index), 16_777_619);
    }
    hash >>>= 0;
    sum = (sum + hash) >>> 0;
    mix ^= hash;
  }
  return `${buildings.length}:${sum}:${mix >>> 0}`;
}

/** Everything about a building that the visibility test needs and that never changes
 * for a given snapshot. Computed once per WorldData instead of per check — see
 * buildingMetricsFor. */
interface BuildingMetric {
  building: WorldBuilding;
  centroid: LocalPoint;
  sphere: THREE.Sphere;
}

/** A world root under construction, before it is swapped in for the live one. */
interface SurfaceBuild {
  target: THREE.Group;
  /** Ground/water fallback planes, which have to be re-anchored on commit. */
  anchored: THREE.Object3D[];
  roadMaterials: Map<string, THREE.ShaderMaterial>;
  /** The two things in the world that move on their own. Held here so the commit can
   * hand them to setAnimationTime — a staged build must not drive anything that isn't
   * on screen yet. */
  trafficLights: TrafficLightBatch | null;
  neonSigns: NeonSignBatch | null;
  streetLights: StreetLightBatch | null;
  busStops: BusStopBatch | null;
  /** The build's water and shoreline-foam materials — one pair, shared by every water
   * polygon in it — held here so the commit can start writing the clock into them. */
  waterMaterials: THREE.Material[];
  /** Physics collision frames harvested from the batches above as they are built. */
  props: WorldProp[];
  bridgeColliders: BridgeCollider[];
  builtCounts: WorldBuildCounts;
  /** Set once the roads layer builds — see getRoadElevationProfiles. */
  roadElevationProfiles: Map<string, RoadElevationProfile>;
}

const emptyBuildCounts = (): WorldBuildCounts => ({ buildings: 0, roads: 0, water: 0, parks: 0, objects: 0 });

const inputBuildCounts = (data: WorldData): WorldBuildCounts => ({
  buildings: data.buildings.length,
  roads: data.roads.length,
  water: data.water.length,
  parks: data.parks.length,
  objects: data.objects.length,
});

export function createThreeWorld(scene: THREE.Scene): ThreeWorld {
  let root = new THREE.Group();
  let options = { ...DEFAULT_RENDER_OPTIONS };
  let effective: EffectiveRenderQuality = resolveEffectiveRenderQuality(options, 1);
  let currentData: WorldData | null = null;
  // Shared across every facade renderer instance for this world's whole lifetime —
  // see createFacadeRenderer's `materials` option doc comment. buildBuildingsLayer
  // now rebuilds far more often than the old ~1s streaming cadence (camera-frustum/
  // render-budget checks, up to 4x/sec), and a fresh materials Map per rebuild meant
  // recompiling every facade shader program from scratch each time — a real, serious
  // cost under WebGL, observed to pile up into multi-second stalls while driving
  // continuously. Disposed once, explicitly, in this world's own final clear() below —
  // never by an individual facadeRenderer instance.
  const facadeMaterials = new Map<string, THREE.ShaderMaterial>();
  const windowLights = createWindowLights(scene);
  let facadeRenderer: SvartaksiFacadeRenderer = createFacadeRenderer(root, { materials: facadeMaterials });
  const groundAnchored: THREE.Object3D[] = [];
  const scheduler = createBuildScheduler();
  /** Set while a *full* rebuild is staged. Visibility checks stand down for its
   * duration: the layer they would rebuild is about to be replaced wholesale anyway,
   * and starting one would cancel the full rebuild it is a subset of. */
  let rebuildingAll = false;
  scene.add(root);

  let anchorX = 0;
  let anchorZ = 0;
  let budgetScale = 1;
  /** Sorted, joined ids of the last buildings layer actually built — lets
   * updateVisibleBuildings skip a rebuild when the visible set hasn't changed
   * (the common case most frames, once the camera settles). An empty string is a
   * legitimate key (zero visible buildings), so a *separate* forceRebuild flag —
   * not a sentinel key value — is what makes setRenderBudgetScale's cap change
   * actually take effect on the next check. */
  let lastVisibleBuildingKey = '';
  /** The visible set an incremental buildings rebuild is currently working towards.
   * Without it, a rebuild that outlives one visibility check would be cancelled and
   * restarted by the next check for the very same set, forever. */
  let pendingVisibleBuildingKey: string | null = null;
  let forceRebuild = false;
  /** Road materials from the most recent renderSurfaces pass. Unlike facadeMaterials
   * these stay owned by the meshes that use them (disposed with the surfaces layer);
   * this reference only exists so setSceneLighting can reach the live ones. */
  let roadMaterials = new Map<string, THREE.ShaderMaterial>();
  let sceneLighting: SceneLighting | null = null;
  /** The live animated batches, or null when the current world has none of that kind.
   * Replaced wholesale on commit — a staged build's batches are never driven. */
  let trafficLights: TrafficLightBatch | null = null;
  let props: WorldProp[] = [];
  let bridgeColliders: BridgeCollider[] = [];
  let neonSigns: NeonSignBatch | null = null;
  let streetLights: StreetLightBatch | null = null;
  let busStops: BusStopBatch | null = null;
  /** The committed build's water/foam materials — see SurfaceBuild.waterMaterials. */
  let waterMaterials: THREE.Material[] = [];
  /** The committed build's own RoadElevationProfile per road id — the same map
   * buildRoadGeometry sampled to place the rendered deck, so physics's ground-height
   * callback (see svartaksiRuntime.tsx) reads identical heights rather than a second,
   * independently-derived copy. Empty until the first surfaces build with roads on. */
  let roadElevationProfiles: Map<string, RoadElevationProfile> = new Map();
  /** Last time setAnimationTime was given, replayed into a freshly committed world so
   * its signals show the right aspect on their first frame rather than defaulting to
   * all-red for a tick. */
  let animationTime = 0;
  /** Slice estimate for the build currently in flight — see estimateBuildSteps. */
  let estimatedSteps = 1;
  let buildStage = 'Waiting for world data';
  let inputCounts = emptyBuildCounts();
  let builtCounts = emptyBuildCounts();
  /** Per-snapshot building geometry cache, rebuilt lazily whenever `currentData`
   * changes identity. Recomputing every centroid and bounding sphere on each of the
   * four visibility checks a second was pure repeated work: neither depends on the
   * camera, the anchor or the render budget. */
  let buildingMetrics: BuildingMetric[] = [];
  let buildingMetricsSource: WorldData | null = null;

  const buildingMetricsFor = (data: WorldData): BuildingMetric[] => {
    if (buildingMetricsSource === data) return buildingMetrics;
    buildingMetricsSource = data;
    buildingMetrics = data.buildings.map((building) => {
      const centroid = ringCentroid(building.rings[0] ?? []);
      return { building, centroid, sphere: buildingBoundingSphere(building, centroid) };
    });
    return buildingMetrics;
  };

  /** Ground elevation index buildings/roofs/facade walls are placed on — the same
   * `terrainClearanceFor` gate physics's `groundProfile` (svartaksiRuntime.tsx) samples for
   * `buildingColliderDescriptor`, so a building drawn on a landuse mound isn't sunk
   * relative to its own physics collider. Cached by (data, options) identity the same way
   * `buildingMetricsFor` above is: `buildBuildingsInto` can be re-entered several times a
   * second from a pure visibility change (see updateVisibleBuildings) with neither the
   * data nor the terrain settings having actually moved. */
  let buildingTerrainIndex: TerrainIndex = buildTerrainIndex([]);
  let buildingTerrainSource: WorldData | null = null;
  let buildingTerrainOptions: RenderOptions | null = null;

  const buildingTerrainIndexFor = (data: WorldData): TerrainIndex => {
    if (buildingTerrainSource === data && buildingTerrainOptions === options) return buildingTerrainIndex;
    buildingTerrainSource = data;
    buildingTerrainOptions = options;
    buildingTerrainIndex = buildTerrainIndex(terrainClearanceFor(options.parks, data.parks, options.terrain));
    return buildingTerrainIndex;
  };

  /** Re-applies the cached lighting to every custom material currently alive. Called
   * after any rebuild, since a rebuild can mint materials that never saw the last
   * setSceneLighting call. */
  const refreshWindowLighting = () => {
    for (const material of facadeMaterials.values()) {
      material.uniforms.uWindowBrightness.value = options.windowBrightness;
      material.uniforms.uWindowOccupancy.value = options.windowOccupancy;
      material.uniforms.uWindowWarmth.value = options.windowWarmth;
      material.uniforms.uWindowFrameWidth.value = options.windowFrameWidth;
    }
    windowLights.update(facadeRenderer.getWindowLightWalls(), options, sceneLighting?.nightFactor ?? 0, anchorX, anchorZ);
  };

  const refreshSceneLighting = () => {
    refreshWindowLighting();
    if (!sceneLighting) return;
    for (const material of facadeMaterials.values()) applySceneLighting(material, sceneLighting);
    for (const material of roadMaterials.values()) applySceneLighting(material, sceneLighting);
    // The lamps are baked, not simulated: what "switching them on" means is repainting
    // one material from the same night factor everything else is shaded by.
    streetLights?.setNight(sceneLighting.nightFactor);
    busStops?.setNight(sceneLighting.nightFactor);
  };

  /** Pushes the current clock into whatever animates itself. Safe to call every frame
   * and safe to call with nothing built: both batches no-op when empty. */
  const refreshAnimation = () => {
    trafficLights?.update(animationTime);
    neonSigns?.update(animationTime, sceneLighting?.nightFactor ?? 0);
    // One uniform write per material, and there is one pair of them for the whole build.
    for (const material of waterMaterials) setWaterAnimationTime(material, animationTime);
  };

  const disposeMeshesIn = (object: THREE.Object3D) => {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      // An InstancedMesh owns GPU buffers for its matrices and colours on top of its
      // geometry and material. Rebuilds are frequent enough now (every stream, every
      // visibility change) that leaking those adds up.
      if (child instanceof THREE.InstancedMesh) child.dispose();
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    });
  };

  /** Drops the current root and everything under it. Deliberately does *not* touch
   * facadeMaterials: those are keyed by facade profile, not by building, so they stay
   * valid across any rebuild, and disposing them here forced a full recompile of every
   * facade shader on each streamed world — one of the two things that made streaming
   * freeze the game. Only the final dispose() below clears them. */
  const disposeRoot = () => {
    facadeRenderer.dispose();
    disposeMeshesIn(root);
    root.removeFromParent();
    // These live in the surfaces layer that just went away. A rebuild reassigns them a
    // moment later; anything else must not be left holding meshes off the scene graph.
    trafficLights = null;
    props = [];
    neonSigns = null;
    streetLights = null;
    busStops = null;
    // Disposed along with the meshes that held them; keeping the references would leave
    // refreshAnimation writing into materials that no longer exist on any mesh.
    waterMaterials = [];
  };

  const clear = () => {
    windowLights.dispose();
    disposeRoot();
    for (const material of facadeMaterials.values()) material.dispose();
    facadeMaterials.clear();
  };

  /** Tears down just the buildings layer and the facade renderer — leaves
   * ground/parks/water/roads/street-furniture untouched, so re-evaluating building
   * visibility (frustum pan, or a render-budget change) never pays for rebuilding
   * the much cheaper-to-leave-alone surfaces layer. */
  const disposeBuildingsLayer = () => {
    facadeRenderer.dispose();
    const existing = root.getObjectByName(BUILDINGS_LAYER);
    if (!existing) return;
    disposeMeshesIn(existing);
    existing.removeFromParent();
  };

  /**
   * Walls come from exactly one of two sources per building — the detailed facade
   * renderer, or a plain extruded box fallback — never both, so the two
   * representations don't double-draw and z-fight. Facades don't depend on the box
   * fallback being enabled: `buildings` (the box style toggle) and `facades` are
   * independent, so turning the box off while facades stay on still renders full
   * detailed facades, not nothing. The box still covers any single building whose
   * facade record fails to resolve (a degenerate footprint, say) even while the box
   * toggle itself is off, so no building is ever left with a floating roof and no
   * walls beneath it — that guarantee is a data-integrity fallback, not a style
   * choice, so it isn't gated by the box toggle. Roofs are drawn either way, since
   * neither wall representation caps its own top.
   */
  /** Quality tier bounds how many facade wall instances actually get GPU time; the
   * render budget then pulls further inward from that under sustained frame drops
   * (never past it — scale 1 reproduces the tier's own cap exactly). */
  const createBuildingsRenderer = (layer: THREE.Group): SvartaksiFacadeRenderer =>
    createFacadeRenderer(layer, {
      maxInstances: effective.facadeInstances,
      materials: facadeMaterials,
      secondaryDetails: effective.secondaryDetails,
      detailCastShadow: effective.shadowTier !== 'performance',
    });

  function* buildBuildingsInto(
    layer: THREE.Group,
    renderer: SvartaksiFacadeRenderer,
    visibleBuildings: WorldBuilding[],
  ): BuildJob {
    if (!currentData) return;

    const group = (name: string) => {
      const child = new THREE.Group();
      child.name = `world:${name}`;
      layer.add(child);
      return child;
    };

    buildStage = 'Resolving facade layouts and entrances';
    const useFacades = options.facades;
    const facadeDistanceSq = (effective.buildingDistance * FACADE_DETAIL_DISTANCE_FRACTION) ** 2;
    const metricsById = new Map(buildingMetricsFor(currentData).map((metric) => [metric.building.id, metric]));
    // Same ground profile buildingLayer.ts solves the physics colliders against (see
    // svartaksiRuntime.tsx's groundProfile) — every visual building piece below is placed on
    // this same baseY so a building drawn on a landuse mound isn't sunk relative to its
    // own physics collider, which does sample the mound (buildingColliderDescriptor).
    const terrainIndex = buildingTerrainIndexFor(currentData);
    const baseYFor = (building: WorldBuilding): number => {
      const centroid = metricsById.get(building.id)?.centroid ?? ringCentroid(building.rings[0] ?? []);
      return terrainHeightAtIndexed(centroid, terrainIndex);
    };
    const isFacadeRange = (building: WorldBuilding): boolean => {
      const metric = metricsById.get(building.id);
      if (!metric) return true;
      const dx = metric.centroid.x - anchorX;
      const dz = metric.centroid.z - anchorZ;
      return dx * dx + dz * dz <= facadeDistanceSq;
    };
    const facadeRecords = useFacades ? new Map<string, ReturnType<typeof buildFacadeRecord>>() : null;
    if (facadeRecords) {
      for (let index = 0; index < visibleBuildings.length; index += 1) {
        const building = visibleBuildings[index];
        if (!isFacadeRange(building)) continue;
        const facade = buildFacadeRecord(building, {
          buildings: visibleBuildings,
          water: currentData.water,
          baseY: baseYFor(building),
        });
        const record = buildingRecord(building, currentData.source);
        facade?.walls.forEach((wall, wallIndex) => {
          wall.inspection = {
            ...record,
            properties: { ...record.properties, wallIndex },
          };
        });
        facadeRecords.set(building.id, facade);
        if (index % FACADE_RECORD_CHUNK === FACADE_RECORD_CHUNK - 1) yield;
      }
    }
    buildStage = 'Building walls and roof geometry';
    const anyWalls = options.buildings || useFacades;
    const anyBoxFallback = anyWalls
      && (!useFacades || visibleBuildings.some((building) => !facadeRecords?.get(building.id)));
    const buildingsGroup = anyBoxFallback ? group('buildings') : null;
    const roofs = anyWalls ? group('roofs') : null;
    if (anyWalls) {
      for (let index = 0; index < visibleBuildings.length; index += 1) {
        const building = visibleBuildings[index];
        if (index % BUILDING_MESH_CHUNK === BUILDING_MESH_CHUNK - 1) yield;
        const variation = stableNumber(building.id);
        const needsBoxFallback = !useFacades || !facadeRecords?.get(building.id);
        const baseY = baseYFor(building);

        if (buildingsGroup && needsBoxFallback) {
          // Taller buildings trend cooler and less saturated (glass/steel towers),
          // shorter ones keep more of the warm base hue — height joins id-hash
          // randomness so the fallback boxes vary by more than one axis.
          const heightFactor = Math.min(1, building.height / 90);
          const hue = 0.065 + (variation - 0.5) * 0.05 - heightFactor * 0.02;
          const saturation = Math.max(0.02, 0.08 + variation * 0.14 - heightFactor * 0.05);
          const color = new THREE.Color().setHSL(hue, saturation, 0.38 + variation * 0.2);
          // Pushed behind anything sharing its footprint. The polygonOffset is inert
          // under the log depth buffer; the bias is what does it. See depthBias.ts.
          const mesh = new THREE.Mesh(buildBuildingGeometry(building), applyLogDepthBias(
            new THREE.MeshStandardMaterial({
              color, roughness: 0.7 + variation * 0.2 - heightFactor * 0.15,
              metalness: heightFactor * 0.15,
              polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
            }),
            DEPTH_BIAS.behind,
          ));
          mesh.position.y = baseY;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.userData[INSPECTION_USER_DATA_KEY] = buildingRecord(building, currentData.source);
          buildingsGroup.add(mesh);
        }

        // Three broad roof-material bands (slate / brown-red / warm terracotta) with
        // continuous lightness and roughness drift inside each, so roofs read as
        // naturally varied rather than repeating a fixed palette.
        const roofStyle = resolveRoofStyle(building);
        const roofColor = new THREE.Color(roofStyle.color);
        const roof = new THREE.Mesh(buildRoofGeometry(building), new THREE.MeshStandardMaterial({
          color: roofColor, roughness: roofStyle.roughness,
        }));
        roof.position.y = baseY;
        roof.name = `world:roof:${building.id}`;
        roof.castShadow = true;
        roof.receiveShadow = true;
        roof.userData[INSPECTION_USER_DATA_KEY] = {
          ...buildingRecord(building, currentData.source),
          category: 'roof',
          title: `Roof ${building.id}`,
          properties: {
            ...buildingRecord(building, currentData.source).properties,
            roofStyle: building.appearance?.roofShape
              ?? String(building.properties['roof:shape'] ?? 'unknown'),
          },
        } satisfies WorldInspectionRecord;
        roofs?.add(roof);
      }
    }
    if (useFacades) {
      yield;
      const facades = visibleBuildings
        .map((building) => facadeRecords?.get(building.id))
        .filter((value): value is SvartaksiFacadeBuilding => value != null);
      // One indivisible step: the renderer batches every wall into a handful of
      // InstancedMeshes, and a half-filled batch is not a drawable intermediate state.
      buildStage = 'Batching facade windows, doors and details';
      renderer.replace(facades);
    }
  }

  /** Buildings are both distance-limited (MAX_BUILDING_DRAW_DISTANCE, scaled by the
   * render budget, much tighter than roads/water/terrain) and now also
   * frustum-limited (skipped entirely when `camera` is null, e.g. the very first
   * build), then nearest-first sorted before a final 1500 hard cap, so a dense area's
   * budget is spent on the closest/most-visible buildings rather than whichever 1500
   * happen to come first in the source data. */
  const computeVisibleBuildings = (camera: THREE.Camera | null): WorldBuilding[] => {
    if (!currentData) return [];
    let frustum: THREE.Frustum | null = null;
    if (camera) {
      camera.updateMatrixWorld();
      const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);
    }
    // Distance first, frustum second: the distance test is two subtractions and a
    // compare, the frustum test is six plane evaluations, and the distance test rejects
    // the large majority on any real snapshot.
    const maxDistanceSq = effective.buildingDistance ** 2;
    const candidates: Array<{ building: WorldBuilding; distanceSq: number }> = [];
    for (const { building, centroid, sphere } of buildingMetricsFor(currentData)) {
      const dx = centroid.x - anchorX;
      const dz = centroid.z - anchorZ;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > maxDistanceSq) continue;
      if (frustum && !frustum.intersectsSphere(sphere)) continue;
      candidates.push({ building, distanceSq });
    }
    return candidates
      .sort((a, b) => a.distanceSq - b.distanceSq)
      .slice(0, MAX_VISIBLE_BUILDINGS)
      .map(({ building }) => building);
  };

  function* buildSurfacesInto(staging: SurfaceBuild, data: WorldData): BuildJob {
    buildStage = 'Selecting nearby terrain and indexing ground heights';
    const { target, anchored, waterMaterials: stagedWaterMaterials } = staging;
    // Water/roads/terrain draw from a much bigger radius than buildings/facades —
    // see MAX_BUILDING_DRAW_DISTANCE's doc comment for why — and are never
    // frustum-culled, only distance-culled, so they keep drawing far down a straight
    // road even when the camera pans away momentarily.
    const nearbyParks = data.parks.filter((park) => anyPointWithinDrawDistance(park.rings[0] ?? [], anchorX, anchorZ, MAX_TERRAIN_DRAW_DISTANCE));
    const nearbyWater = data.water.filter((water) => anyPointWithinDrawDistance(water.rings[0] ?? [], anchorX, anchorZ, MAX_TERRAIN_DRAW_DISTANCE));
    const nearbyRoads = data.roads.filter((road) => anyPointWithinDrawDistance(road.points, anchorX, anchorZ, MAX_TERRAIN_DRAW_DISTANCE));
    // Inclusion (nearbyRoads, everything in draw range) is separate from surface
    // rendering — a tunnel or fully-covered road still needs a RoadElevationProfile for
    // routing/physics even though nothing paints it. `visibleRoads` is what surface
    // geometry, street furniture, lamps, signals and collision-adjacent placement
    // (bus stops, mailboxes) actually draw from; `nearbyRoads` stays the input to
    // routing and elevation. See surfaceVisibility.ts and backlog item 9.
    //
    // The debug override is the one path that can widen `visibleRoads` back to
    // `nearbyRoads` — gated on `options.debugShowHiddenRoads`, itself only reachable
    // from the developer panel behind `?dev=1` (see devMode.ts and App.tsx). A normal
    // player never sees this flag.
    const visibleRoads = options.debugShowHiddenRoads
      ? nearbyRoads
      : nearbyRoads.filter((road) => isSurfaceVisible(road));
    staging.builtCounts.parks = options.parks ? nearbyParks.length : 0;
    staging.builtCounts.water = options.water ? nearbyWater.length : 0;
    // What the carriageway loop below actually paints, as distinct from `visibleRoads`,
    // which stays the input to every *placement* stage (lamps, signals, bus stops, post
    // boxes). Minor classes — footpaths, alleys, service roads — are cut to a shorter,
    // fog-derived radius by roadDrawPolicy: they are the most numerous roads in OSM urban
    // data and the least visible at distance, so building them out to the full terrain
    // radius is geometry nobody can see through the fog. Major roads are untouched, since
    // an arterial running to the horizon is the reason roads are distance-culled rather
    // than frustum-culled at all.
    //
    // Splitting the two sets rather than narrowing `visibleRoads` is what keeps this
    // change confined to rendering: the paint radius is guaranteed wider than every
    // tier's building distance (asserted in roadDrawPolicy's tests), so every road a prop
    // is placed against is still painted, and routing/physics read `nearbyRoads` anyway.
    const paintedRoads = options.debugShowHiddenRoads
      ? visibleRoads
      : visibleRoads.filter((road) => anyPointWithinDrawDistance(
          road.points, anchorX, anchorZ, roadPaintDistance(road.kind, MAX_TERRAIN_DRAW_DISTANCE),
        ));
    staging.builtCounts.roads = options.roads ? paintedRoads.length : 0;
    staging.builtCounts.objects = options.streetFurniture ? data.objects.length : 0;

    // Roads clear it and trees stand on it, and both blocks are in this one build — so
    // the profile is walked once, lazily (a build with neither layer on never pays for
    // it). Only against terrain that is actually being rendered: with parks off there is
    // nothing for a road to be buried under.
    let terrainClearanceCache: TerrainClearance[] | null = null;
    const terrainProfile = () => {
      terrainClearanceCache ??= terrainClearanceFor(options.parks, nearbyParks, options.terrain);
      return terrainClearanceCache;
    };
    // The spatial index (backlog item 3) over the same cached array, built once per
    // build regardless of how many roads/trees/objects query it. Every road-point and
    // tree-placement lookup below goes through this instead of rescanning the whole
    // park/landuse set per query.
    let terrainIndexCache: TerrainIndex | null = null;
    const terrainIndex = () => {
      terrainIndexCache ??= buildTerrainIndex(terrainProfile());
      return terrainIndexCache;
    };


    const group = (name: string) => {
      const child = new THREE.Group();
      child.name = `world:${name}`;
      target.add(child);
      return child;
    };

    if (options.ground) {
      const ground = new THREE.Mesh(
        groundPlaneGeometry(),
        new THREE.MeshStandardMaterial({ color: 0x8b927d, roughness: 1 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(anchorX, 0, anchorZ);
      // A single flat 6km plane is the largest caster in the scene by orders of
      // magnitude and can only ever shadow itself. Leaving it in the caster set spent
      // the shadow map's depth range on it and produced acne across the whole ground.
      ground.castShadow = false;
      ground.receiveShadow = true;
      group('ground').add(ground);
      anchored.push(ground);
    }

    buildStage = 'Building parks and landuse relief';
    const parks = options.parks ? group('parks') : null;
    if (parks) {
      for (let index = 0; index < nearbyParks.length; index += 1) {
        const park = nearbyParks[index];
        if (index % AREA_CHUNK === AREA_CHUNK - 1) yield;
        const mesh = new THREE.Mesh(buildParkGeometry(park, options.terrain), new THREE.MeshStandardMaterial({
          color: landuseColor(park),
          ...landuseMaterialOptions(park.kind),
        }));
        // Nothing here casts: every landuse kind now rises by well under a metre (see
        // the terrain height bands), and a shadow from a bank that low is a dark rim tracing
        // every polygon edge in the world — including the residential/commercial
        // blankets that cover whole street grids. The trees standing on it still cast.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData[INSPECTION_USER_DATA_KEY] = areaRecord(park, data.source, 'area');
        parks.add(mesh);
      }
    }
    buildStage = 'Building water surfaces and shoreline bands';
    const waterGroup = options.water ? group('water') : null;
    if (waterGroup) {
      const fallback = new THREE.Mesh(
        groundPlaneGeometry(),
        new THREE.MeshStandardMaterial({ color: 0x214f64, roughness: 0.3, metalness: 0.12 }),
      );
      fallback.name = 'world:water-fallback';
      fallback.rotation.x = -Math.PI / 2;
      fallback.position.set(anchorX, -0.45, anchorZ);
      // Same reasoning as the ground plane it mirrors: a 6km flat sheet has nothing to
      // cast onto but itself.
      fallback.castShadow = false;
      fallback.receiveShadow = true;
      waterGroup.add(fallback);
      anchored.push(fallback);
      // One water material and one foam material for the whole build, not one pair per
      // polygon (backlog item 10: "one shared shader/material per water style"). Both
      // carry a `uWaterTime` uniform the animation tick writes, and a per-polygon copy
      // would mean a hundred uniform writes a frame and a hundred shader programs to
      // compile on a stream where one will do.
      const waterMaterial = createWaterMaterial(effective.cinematicMaterials);
      const foamMaterial = createShorelineFoamMaterial();
      const shallowsMaterial = createShallowsMaterial();
      stagedWaterMaterials.push(waterMaterial, foamMaterial);
      for (let index = 0; index < nearbyWater.length; index += 1) {
        const water = nearbyWater[index];
        if (index % AREA_CHUNK === AREA_CHUNK - 1) yield;
        // Same shared surface datum as roads/trees/physics ground (terrainIndex, built
        // from the rendered park/landuse set above) rather than a fixed absolute y — see
        // waterSurfaceHeightAtIndexed's doc comment for why a hard-coded height drifted
        // relative to a mound the water polygon bordered or sat inside.
        const waterY = waterSurfaceHeightAtIndexed(water.rings[0] ?? [], terrainIndex());
        const surface = new THREE.Mesh(areaGeometry(water.rings[0], waterY), waterMaterial);
        surface.name = `world:water-surface:${water.id}`;
        surface.renderOrder = 2;
        // Transparent and depthWrite:false — writing it into an opaque shadow map made
        // lakes cast solid black shadows onto the ground plane just beneath them.
        surface.castShadow = false;
        surface.receiveShadow = true;
        surface.userData[INSPECTION_USER_DATA_KEY] = areaRecord(water, data.source, 'water');
        waterGroup.add(surface);

        // The shallows go on first and lowest of the three: the wash of bottom colour the
        // foam then breaks over. All three offsets are millimetres off the shared datum
        // rather than independent constants, so they cannot drift apart.
        const shallows = buildShallowsGeometry(water.rings[0] ?? [], waterY + 0.0005);
        if (shallows) {
          const shelf = new THREE.Mesh(shallows, shallowsMaterial);
          shelf.name = `world:water-shallows:${water.id}`;
          shelf.renderOrder = 3;
          shelf.castShadow = false;
          shelf.receiveShadow = false;
          waterGroup.add(shelf);
        }

        // 1cm above the water plane itself — same relative offset as before, now
        // measured from the shared datum instead of a second independent constant.
        const shoreline = buildShorelineGeometry(water.rings[0] ?? [], waterY + 0.001);
        if (shoreline) {
          const foam = new THREE.Mesh(shoreline, foamMaterial);
          foam.name = `world:water-shoreline:${water.id}`;
          // Above the shallows band it breaks over, and above the surface both sit on.
          foam.renderOrder = 4;
          foam.castShadow = false;
          foam.receiveShadow = false;
          waterGroup.add(foam);
        }
      }
    }
    buildStage = 'Resolving road elevations, bridges and underpasses';
    const roads = options.roads ? group('roads') : null;
    if (roads) {
      // Only clear roads against terrain that's actually being rendered — with parks
      // off there's nothing for a road to be buried under.
      const terrainClearance = terrainProfile();
      // One RoadElevationProfile per road that grade separation actually reaches, built
      // once for the whole nearby set — resolves bridge/tunnel crossings against
      // normalized structure/layer, not just terrain, and carries each lift out through
      // the junctions at its ends until it has ramped back to street level. Physics reads
      // this same map (see svartaksiRuntime.tsx's ground callback) so a deck renders exactly
      // where a vehicle driving it is grounded, ramps included. Every other road — the
      // overwhelming majority — is absent from the map by design and falls back inside
      // buildRoadGeometry to the plain terrain smoothing it always used.
      // Built from every nearby road, not just the visible ones — a hidden road (a
      // tunnel) still needs a profile so physics/routing can ground a vehicle traveling
      // it, even though the loop below never builds a mesh for it.
      // `yield*`, not a plain call: this is the largest single step in the road phase, and
      // running it whole between two yields is a guaranteed dropped frame — the invariant
      // CLAUDE.md states as "heavy work between yields". The generator hands the frame
      // back at each of its own phase boundaries instead.
      const roadElevationProfiles = yield* buildRoadElevationProfilesJob(nearbyRoads, terrainClearance, {
        baseElevation: roadSurfaceElevation,
        // The index this build already holds, rather than a second one built inside the
        // call: the ground query behind it runs once per point of every road profiled,
        // and was the dominant cost of this step until it was indexed. See
        // docs/performance/2026-09-04-road-elevation-terrain-index.md.
        terrainIndex: terrainIndex(),
      });
      staging.roadElevationProfiles = roadElevationProfiles;
      /**
       * One road's own surface height at a point — what `createRoadObstructionTest` needs
       * to tell a street passing under a viaduct from the viaduct's own continuation way.
       *
       * A road carrying a profile is asked for its real, possibly lifted, surface; one
       * without a profile is at grade by definition, and its surface elevation is the
       * whole answer. The single-entry map is what confines the profile lookup to *this*
       * road rather than to whatever else covers the point — a deck and the street beneath
       * it both cover it, and taking the higher of the two would report every underpass as
       * being at deck level. Cached per road because this is asked once per support and a
       * viaduct has many.
       */
      const singleProfileMaps = new Map<string, Map<string, RoadElevationProfile>>();
      const roadSurfaceHeightAt = (road: WorldRoad, x: number, z: number): number => {
        const ownProfile = roadElevationProfiles.get(road.id);
        if (!ownProfile) return roadSurfaceElevation(road);
        let single = singleProfileMaps.get(road.id);
        if (!single) {
          single = new Map([[road.id, ownProfile]]);
          singleProfileMaps.set(road.id, single);
        }
        return roadElevationAtPoint(x, z, single) ?? roadSurfaceElevation(road);
      };
      // One mesh per RoadStyleKey (typically 4-6) instead of one per road (thousands) —
      // roads already share a material per style key (getOrCreateRoadMaterial), so the
      // per-road mesh was the only thing forcing a separate draw call per road. See
      // docs/misc/svartaksidocs/road-geometry-merge.md.
      //
      // Split once more by whether the road actually stands off the ground, because a
      // deck and a ground ribbon need opposite depth behavior — see getOrCreateRoadMaterial's
      // `elevated` parameter. In a snapshot with no grade separation the elevated half of
      // every bucket is simply empty and this costs one extra map lookup per road.
      const byBucket = new Map<string, RoadMeshBucket>();
      /** Parapets for whatever decks this build turns out to contain — merged into one
       * mesh at the end, like the carriageways themselves, rather than one draw call per
       * bridge. Usually empty: a snapshot with no grade separation in it has no railings. */
      const railings: THREE.BufferGeometry[] = [];
      /** Columns and abutments under whatever decks this build contains, merged into one
       * mesh alongside the parapets and for the same reason. Usually empty. */
      const piers: THREE.BufferGeometry[] = [];
      // Sliced by accumulated polyline points rather than by road count: buildRoadGeometry
      // emits vertices per point, so eight 2-point stubs and eight 300-point ring roads
      // are wildly different amounts of work that a fixed road-count cadence charges the
      // same. See ROAD_GEOMETRY_POINT_BUDGET.
      const sliceBudget = createRoadSliceBudget();
      for (let index = 0; index < paintedRoads.length; index += 1) {
        const road = paintedRoads[index];
        if (sliceBudget.shouldYieldAfter(road.points.length)) yield;
        const profile = roadElevationProfiles.get(road.id);
        const geometry = buildRoadGeometry(road, terrainClearance, profile, terrainIndex());
        // buildRoadGeometry returns an attribute-less geometry for a degenerate
        // (<2-point) road; mergeGeometries requires every input to share the same
        // attribute set, so a bare road like that has to be dropped rather than merged.
        if (!geometry.index || geometry.index.count === 0) { geometry.dispose(); continue; }
        const styleKey = getRoadStyleKey(road.kind);
        const elevated = profile ? isElevatedRoadProfile(profile, roadSurfaceElevation(road)) : false;
        // Only a road that is actually a structure is asked for a parapet, so the far
        // commoner at-grade road never pays for re-deriving its deck samples here. A
        // tagged bridge is asked even when it sits low: it was surveyed as a bridge, and
        // a bridge without a railing is the one detail that gives away a flat slab.
        //
        // Clipped to the building draw distance, like the lamps and shelters below and for
        // the same reason: the parapets are one merged mesh, so it is culled as a unit and
        // every post in it is redrawn into the shadow map whether or not it is anywhere
        // near the light's frustum. A railing is also fine detail nobody resolves at the
        // full terrain radius.
        const nearEnoughForDetail = anyPointWithinDrawDistance(road.points, anchorX, anchorZ, effective.buildingDistance);
        // Sampled once and shared by the deck branch and the cutting branch below. A road
        // that is neither raised nor profiled has no structure either way and never pays
        // for it; one that is both (a ramp diving from a deck into a cutting) walks the
        // polyline once rather than twice.
        const structureSamples = (elevated || road.structure === 'bridge' || profile)
          ? roadDeckSamples(road, terrainClearance, profile, terrainIndex())
          : null;
        if (structureSamples && (elevated || road.structure === 'bridge')) {
          const samples = structureSamples;
          const railing = buildRoadRailingGeometry(road, samples.points, samples.elevations, samples.lifts, roadElevationProfiles);
          const thickness = deckThicknessProfile(road, samples.lifts);
          if (thickness) staging.bridgeColliders.push(...bridgeDeckColliders(
            road.id, samples.points, samples.elevations, thickness, road.width,
          ));
          if (railing) {
            staging.bridgeColliders.push(...bridgeRailingColliders(road.id, railing));
            if (nearEnoughForDetail) railings.push(railing);
            else railing.dispose();
          }
          // Supports are built only within the detail radius, like the parapets: they are
          // one merged mesh culled as a unit, so every column in it is redrawn into the
          // shadow map whether or not it is near the light's frustum.
          //
          // A support is skipped where another road's deck already occupies the ground —
          // the same junction lookup the parapets use to open themselves at a merge. A
          // column dropped into the carriageway running under the viaduct would be a
          // concrete block in a live road, and precisely at the underpass the deck exists
          // to cross. Nothing is added to `bridgeColliders`: these are visual supports,
          // and making them solid without first proving no bus route threads between them
          // could wall a road off from the routing graph that still believes it is open.
          if (nearEnoughForDetail) {
            const supports = pierPlacements(
              samples.points, samples.elevations, samples.lifts, thickness, road.width,
              {
                isObstructed: createRoadObstructionTest(
                  nearbyRoads, road.id, samples.points, roadSurfaceHeightAt,
                ),
              },
            );
            const pier = buildBridgePierGeometry(supports);
            if (pier) piers.push(pier);
          }
          yield;
        }
        const key = elevated ? `${styleKey}:deck` : styleKey;
        const bucket = byBucket.get(key);
        if (bucket) bucket.entries.push({ road, geometry });
        else byBucket.set(key, { styleKey, elevated, entries: [{ road, geometry }] });
      }

      for (const { styleKey, elevated, entries } of byBucket.values()) {
        // Deterministic per-road paint order *within* the merged draw call — the same
        // value that used to be each road's own mesh-level renderOrder. See
        // ROAD_STYLE_RENDER_ORDER's doc comment for why cross-mesh ordering is now
        // coarser than this.
        entries.sort((a, b) => roadRenderOrder(a.road) - roadRenderOrder(b.road));
        const geometries: THREE.BufferGeometry[] = [];
        const records: WorldInspectionRecord[] = [];
        for (const { road, geometry } of entries) {
          geometries.push(geometry);
          const record: WorldInspectionRecord = {
            id: road.id,
            category: 'road',
            title: road.kind.replaceAll('_', ' '),
            source: data.source,
            properties: { kind: road.kind, width: road.width },
          };
          // One record per triangle, not per road: the merged mesh has no InstancedMesh
          // to index inspection hits by instanceId, so recordForIntersection falls back
          // to the hit face index instead (see worldInspector.ts).
          const faceCount = geometry.index!.count / 3;
          for (let face = 0; face < faceCount; face += 1) records.push(record);
        }
        const merged = mergeGeometries(geometries, false);
        for (const geometry of geometries) geometry.dispose();
        if (!merged) continue;
        const material = getOrCreateRoadMaterial(entries[0].road.kind, staging.roadMaterials, elevated);
        const mesh = new THREE.Mesh(merged, material);
        // A ground road ribbon is a flat sliver a few centimeters above the ground it sits
        // on: it can only ever cast onto itself, which buys nothing and costs a shadow-map
        // pass over every road in range. A deck is the one road geometry with a world
        // underneath it, and a bridge that lays no shadow on the carriageway it crosses
        // reads as a decal rather than as a structure — so the elevated bucket casts and
        // the ground bucket still doesn't. Both receive.
        //
        // The slab is closed (top, underside, both walls, both caps), which is what makes
        // it a well-behaved caster: Three renders a FrontSide material's back faces into
        // the shadow map, so a closed volume gives the depth pass a surface on the far
        // side of the light to record instead of the lit surface itself.
        mesh.castShadow = elevated;
        mesh.receiveShadow = true;
        mesh.renderOrder = ROAD_STYLE_RENDER_ORDER[styleKey] + (elevated ? ELEVATED_ROAD_RENDER_ORDER_OFFSET : 0);
        mesh.userData[INSPECTION_USER_DATA_KEY] = records;
        roads.add(mesh);
      }

      if (piers.length) {
        yield;
        const merged = mergeGeometries(piers, false);
        for (const geometry of piers) geometry.dispose();
        if (merged) {
          const pierMesh = new THREE.Mesh(merged, createPierMaterial());
          pierMesh.name = 'world:bridge-piers';
          pierMesh.castShadow = true;
          pierMesh.receiveShadow = true;
          roads.add(pierMesh);
        }
      }

      if (railings.length) {
        yield;
        const merged = mergeGeometries(railings, false);
        for (const geometry of railings) geometry.dispose();
        if (merged) {
          // Opaque, depth-writing, and standing well clear of every surface it touches, so
          // none of the ordering care the road ribbons themselves need applies here: a
          // parapet is ordinary geometry and can be left to the depth buffer.
          const railingMesh = new THREE.Mesh(merged, createRailingMaterial());
          railingMesh.name = 'world:road-railings';
          railingMesh.castShadow = true;
          railingMesh.receiveShadow = true;
          roads.add(railingMesh);
        }
      }
    }
    if (effective.treeInstances > 0) {
      buildStage = 'Placing trees and their collision shapes';
      yield;
      // Landuse is extruded terrain, so a tree has to stand on top of whatever polygon
      // it grows out of rather than at y=0. Scattered trees know their own polygon;
      // mapped ones are looked up against the same bounding-box profile the roads use.
      const groundAt = (point: LocalPoint) => terrainHeightAtXZIndexed(point.x, point.z, terrainIndex());
      // Scattered trees are clipped to the (much tighter) building radius rather than
      // the terrain radius the polygons themselves use. An InstancedMesh is culled as
      // one unit, so every tree in the batch is redrawn into the shadow map every frame
      // whether or not it is anywhere near the light's frustum — filling that batch out
      // to 2km is paying for thousands of trees nothing can see.
      const treeAreas = options.parks
        ? nearbyParks.filter((park) =>
          anyPointWithinDrawDistance(park.rings[0] ?? [], anchorX, anchorZ, effective.buildingDistance))
        : [];
      // Individually mapped trees first, so the budget goes to the ones with real
      // positions before it is spent on scattered fill.
      // `yield*`, not a plain call: scattering a city's worth of forests is one of the
      // three stages that used to run whole between two yields, and it is why build slices
      // overran the 4ms budget by up to eleven times. See generateTreesJob.
      const scattered = yield* generateTreesJob(treeAreas, effective.treeInstances, groundAt);
      const trees = mappedTrees(data.objects, groundAt)
        .concat(scattered)
        .slice(0, effective.treeInstances);
      if (trees.length) {
        const treeInstances = createTreeInstances(trees);
        target.add(treeInstances);
        staging.props.push(...treeProps(treeInstances, trees, anchorX, anchorZ));
      }
    }
    if (options.streetLights && visibleRoads.length && effective.streetLightInstances > 0) {
      buildStage = 'Placing street lamps';
      yield;
      // Street-light count also pulls in under the render budget, but (unlike
      // buildings) only takes effect the next time surfaces rebuild — a data
      // stream/option change, not every frustum-check tick — since lamp posts are a
      // minor cost next to facades and don't need per-frame responsiveness.
      //
      // Clipped to the building draw distance, like the signals, shelters and post boxes
      // below and for the same two reasons: an InstancedMesh is culled as one unit, so a
      // batch reaching the full terrain radius redraws every distant lamp into the shadow
      // map; and the `slice` below keeps whichever lamps the walk happened to reach
      // first, so without clipping the surviving lamps were chosen by road order rather
      // than by being anywhere near the player.
      const lights = (yield* generateStreetLightsJob(
        visibleRoads.filter((road) => anyPointWithinDrawDistance(road.points, anchorX, anchorZ, effective.buildingDistance)),
        data.buildings,
        {
          // The same two answers physics grounds a body on, so a post stands exactly on
          // the surface a player walking up to it stands on — the landuse extrusion
          // beside the road, or the deck itself where the road is a bridge.
          groundHeightAt: (x, z) => terrainHeightAtXZIndexed(x, z, terrainIndex()),
          deckHeightAlong: (road, distanceAlong) => {
            const profile = staging.roadElevationProfiles.get(road.id);
            return profile ? sampleRoadElevation(profile, distanceAlong) : null;
          },
        },
      )).slice(0, effective.streetLightInstances);
      if (lights.length) {
        staging.streetLights = createStreetLightInstances(lights);
        target.add(staging.streetLights.group);
        staging.props.push(...streetLightProps(staging.streetLights.group, lights, anchorX, anchorZ));
      }
    }
    if (options.streetLights && visibleRoads.length) {
      buildStage = 'Building traffic signals';
      yield;
      // Signalised junctions ride the street-lighting toggle: they are lights on poles,
      // they scale with the same budget, and a player turning street lighting off to
      // claw back frames does not want a second, separate pole budget left running.
      const signals = yield* findTrafficSignalsJob(
        visibleRoads.filter((road) => anyPointWithinDrawDistance(road.points, anchorX, anchorZ, effective.buildingDistance)),
        Math.min(MAX_TRAFFIC_SIGNALS, effective.streetLightInstances),
      );
      if (signals.length) {
        const grounded = standOnGround(signals, (x, z) => terrainHeightAtXZIndexed(x, z, terrainIndex()));
        staging.trafficLights = createTrafficLights(grounded);
        target.add(staging.trafficLights.group);
        staging.props.push(...trafficSignalProps(staging.trafficLights.group, grounded, anchorX, anchorZ));
      }
    }
    /** Shelters already standing this build, so the post boxes can keep out of them. */
    let placedStops: BusStopPlacement[] = [];
    if (options.streetFurniture && visibleRoads.length) {
      buildStage = 'Placing bus shelters';
      yield;
      // Shelters ride the street-furniture toggle rather than the lighting one: their
      // tube is baked into a material colour, so turning them off buys back geometry,
      // not lights. Clipped to the building draw distance because an InstancedMesh is
      // culled as one unit and a 2km batch redraws every shelter into the shadow map.
      const stops = (yield* generateBusStopsJob(
        visibleRoads.filter((road) => anyPointWithinDrawDistance(road.points, anchorX, anchorZ, effective.buildingDistance)),
        data.buildings,
      )).slice(0, MAX_BUS_STOPS);
      if (stops.length) {
        const grounded = standOnGround(stops, (x, z) => terrainHeightAtXZIndexed(x, z, terrainIndex()));
        // The post boxes keep out of the shelters by position alone, so they read the
        // grounded set too rather than a second copy that could drift from it.
        placedStops = grounded;
        staging.busStops = createBusStopInstances(grounded);
        target.add(staging.busStops.group);
        staging.props.push(...busStopProps(staging.busStops.group, grounded, anchorX, anchorZ));
      }
    }
    if (options.streetFurniture) {
      buildStage = 'Placing bins, benches, fountains and mapped objects';
      yield;
      const generated = yield* generateStreetFurniture(data, { x: anchorX, z: anchorZ }, effective.buildingDistance, placedStops);
      const objects = data.objects.filter((object) => withinDrawDistance(object.point, anchorX, anchorZ, effective.buildingDistance)).concat(generated);
      const groundAt = (x: number, z: number) => terrainHeightAtXZIndexed(x, z, terrainIndex());
      const objectInstances = createObjectInstances({ ...data, objects }, groundAt);
      target.add(objectInstances);
      staging.props.push(...mappedObjectProps(objectInstances, objects, anchorX, anchorZ, groundAt));
      staging.builtCounts.objects = objects.length;
    }
    if (options.streetFurniture && (visibleRoads.length || data.objects.length)) {
      buildStage = 'Placing mailboxes';
      yield;
      // Same clipping as the shelters, and for the same reason: one InstancedMesh is
      // culled as a unit, so a batch that reaches past the buildings still redraws every
      // box into the shadow map.
      const boxRoads = visibleRoads.filter((road) =>
        anyPointWithinDrawDistance(road.points, anchorX, anchorZ, effective.buildingDistance));
      // Surveyed boxes first, and they also join the avoid list — a mapped box is a real
      // one, so a generated box has to give way to it rather than stand beside it.
      const mapped = yield* mappedMailboxesJob(
        data.objects
          .filter((object) => object.kind === 'post_box'
            && withinDrawDistance(object.point, anchorX, anchorZ, effective.buildingDistance))
          .map((object) => object.point),
        boxRoads,
      );
      const mailboxes = mapped
        .concat(yield* generateMailboxesJob(boxRoads, [...placedStops, ...mapped], data.buildings))
        .slice(0, MAX_MAILBOXES);
      if (mailboxes.length) {
        const grounded = standOnGround(mailboxes, (x, z) => terrainHeightAtXZIndexed(x, z, terrainIndex()));
        const mailboxInstances = createMailboxInstances(grounded);
        target.add(mailboxInstances);
        staging.props.push(...mailboxProps(mailboxInstances, grounded, anchorX, anchorZ));
      }
    }
    if (options.streetFurniture && data.objects.length && data.buildings.length) {
      buildStage = 'Building neon signs';
      yield;
      // Clipped to the *building* draw distance, not the terrain one: a sign hangs on a
      // facade, so it has nothing to hang on past the point buildings stop being drawn.
      const signs = yield* generateNeonSignsJob(
        data.objects.filter((object) => withinDrawDistance(object.point, anchorX, anchorZ, effective.buildingDistance)),
        data.buildings,
        MAX_NEON_SIGNS,
      );
      if (signs.length) {
        staging.neonSigns = createNeonSigns(signs);
        target.add(staging.neonSigns.group);
      }
    }
  }

  /**
   * Rebuilds everything into a detached group and swaps it in only once it is finished.
   * The world on screen is never partially torn down: either the old one is showing or
   * the new one is, with no frame in between where the city is half missing. That is
   * what makes it safe to spread the work over several frames.
   */
  function* rebuildAllJob(data: WorldData): BuildJob {
    const staging: SurfaceBuild = {
      target: new THREE.Group(),
      anchored: [],
      waterMaterials: [],
      roadMaterials: new Map<string, THREE.ShaderMaterial>(),
      trafficLights: null,
      neonSigns: null,
      streetLights: null,
      busStops: null,
      props: [],
      bridgeColliders: [],
      builtCounts: emptyBuildCounts(),
      roadElevationProfiles: new Map(),
    };
    staging.target.name = `world:${data.source}`;
    let renderer: SvartaksiFacadeRenderer | null = null;
    let committed = false;
    try {
      yield* buildSurfacesInto(staging, data);

      const visible = computeVisibleBuildings(null);
      const layer = new THREE.Group();
      layer.name = BUILDINGS_LAYER;
      staging.target.add(layer);
      renderer = createBuildingsRenderer(layer);
      yield* buildBuildingsInto(layer, renderer, visible);
      staging.builtCounts.buildings = options.buildings || options.facades ? visible.length : 0;

      disposeRoot();
      root = staging.target;
      facadeRenderer = renderer;
      roadMaterials = staging.roadMaterials;
      trafficLights = staging.trafficLights;
      neonSigns = staging.neonSigns;
      streetLights = staging.streetLights;
      busStops = staging.busStops;
      waterMaterials = staging.waterMaterials;
      props = staging.props;
      bridgeColliders = staging.bridgeColliders;
      builtCounts = staging.builtCounts;
      roadElevationProfiles = staging.roadElevationProfiles;
      groundAnchored.length = 0;
      groundAnchored.push(...staging.anchored);
      // The anchor may have moved several times while this was building — the ground
      // and water fallback planes have to land where the camera is *now*, not where it
      // was when they were created.
      for (const object of groundAnchored) object.position.set(anchorX, object.position.y, anchorZ);
      scene.add(root);
      lastVisibleBuildingKey = visibleFingerprint(visible);
      forceRebuild = false;
      committed = true;
      buildStage = 'World committed';
      refreshSceneLighting();
      refreshAnimation();
    } finally {
      rebuildingAll = false;
      if (!committed) {
        renderer?.dispose();
        disposeMeshesIn(staging.target);
      }
    }
  }

  /** Same staging discipline as rebuildAllJob, for the buildings layer alone. */
  function* rebuildBuildingsJob(visible: WorldBuilding[]): BuildJob {
    const layer = new THREE.Group();
    layer.name = BUILDINGS_LAYER;
    const renderer = createBuildingsRenderer(layer);
    let committed = false;
    try {
      yield* buildBuildingsInto(layer, renderer, visible);
      builtCounts = { ...builtCounts, buildings: options.buildings || options.facades ? visible.length : 0 };
      disposeBuildingsLayer();
      facadeRenderer = renderer;
      root.add(layer);
      lastVisibleBuildingKey = visibleFingerprint(visible);
      forceRebuild = false;
      committed = true;
      buildStage = 'World committed';
      refreshSceneLighting();
    } finally {
      pendingVisibleBuildingKey = null;
      if (!committed) {
        renderer.dispose();
        disposeMeshesIn(layer);
      }
    }
  }

  const startRebuildAll = (data: WorldData, rebuild?: RebuildOptions) => {
    estimatedSteps = estimateBuildSteps(data);
    inputCounts = inputBuildCounts(data);
    // Flags are raised *after* start, because start cancels whatever was in flight and
    // that job's own cleanup runs synchronously inside the call.
    scheduler.start(rebuildAllJob(data));
    rebuildingAll = true;
    if (!rebuild?.incremental) scheduler.flush();
  };

  return {
    replace(data, rebuild) {
      currentData = data;
      startRebuildAll(data, rebuild);
    },
    pump(budgetMs) {
      return scheduler.pump(budgetMs);
    },
    isBuilding() {
      return scheduler.isBusy();
    },
    buildProgress() {
      if (!scheduler.isBusy()) return 1;
      return Math.min(0.99, scheduler.stepsRun() / Math.max(1, estimatedSteps));
    },
    buildStage: () => buildStage,
    buildDiagnostics() {
      const diagnostics = scheduler.diagnostics();
      return {
        generationId: diagnostics.generationId,
        estimatedSlices: estimatedSteps,
        finishedSlices: diagnostics.finishedSlices,
        worstSliceMs: diagnostics.worstSliceMs,
        elapsedMs: diagnostics.elapsedMs,
        complete: diagnostics.complete,
        replacementCount: diagnostics.replacementCount,
        sliceHistogram: diagnostics.sliceHistogram,
        input: { ...inputCounts },
        built: { ...builtCounts },
      };
    },
    setRenderOptions(nextOptions) {
      const appearanceOnly = onlyWindowOptionsChanged(options, nextOptions);
      options = { ...nextOptions };
      refreshWindowLighting();
      if (appearanceOnly) return;
      effective = resolveEffectiveRenderQuality(options, budgetScale);
      if (currentData) startRebuildAll(currentData);
    },
    setAnchor(x, z) {
      anchorX = x;
      anchorZ = z;
      for (const object of groundAnchored) object.position.set(x, object.position.y, z);
    },
    updateVisibleBuildings(camera, rebuild) {
      if (!currentData) return;
      // A full rebuild already covers this layer, and starting a partial one would
      // cancel it — losing everything it had staged, over and over, so a world streamed
      // while driving could never finish.
      refreshWindowLighting();
      if (rebuildingAll) return;
      const visible = computeVisibleBuildings(camera);
      const key = visibleFingerprint(visible);
      if (!forceRebuild && (key === lastVisibleBuildingKey || key === pendingVisibleBuildingKey)) return;
      estimatedSteps = Math.ceil(visible.length / FACADE_RECORD_CHUNK)
        + Math.ceil(visible.length / BUILDING_MESH_CHUNK) + 1;
      scheduler.start(rebuildBuildingsJob(visible));
      pendingVisibleBuildingKey = key;
      if (!rebuild?.incremental) scheduler.flush();
    },
    setSceneLighting(lighting) {
      sceneLighting = lighting;
      refreshSceneLighting();
      // Night factor is half of what the neon reads from, so a time-of-day change has to
      // reach the signs immediately rather than waiting for the next animation tick.
      neonSigns?.update(animationTime, lighting.nightFactor);
    },
    setAnimationTime(seconds) {
      animationTime = seconds;
      refreshAnimation();
    },
    getProps: () => props,
    getBridgeColliders: () => bridgeColliders,
    getRoadElevationProfiles: () => roadElevationProfiles,
    getInspectionTargets() {
      const targets: THREE.Object3D[] = [];
      root.traverse((object) => {
        if (object.userData[INSPECTION_USER_DATA_KEY]) targets.push(object);
      });
      return targets;
    },
    setRenderBudgetScale(scale) {
      const clamped = Math.min(1, Math.max(0.35, scale));
      if (Math.abs(clamped - budgetScale) < 0.001) return;
      budgetScale = clamped;
      effective = resolveEffectiveRenderQuality(options, budgetScale);
      if (currentData) startRebuildAll(currentData);
      else forceRebuild = true;
    },
    dispose() {
      scheduler.cancel();
      clear();
    },
  };
}

function buildingRecord(building: WorldBuilding, source: WorldData['source']): WorldInspectionRecord {
  return {
    id: building.id,
    category: 'building',
    title: String(building.appearance?.buildingUse ?? building.appearance?.buildingKind ?? `Building ${building.id}`),
    source,
    properties: sanitizeInspectionProperties({
      ...building.appearance,
      ...building.properties,
      levels: building.appearance?.levels,
    }),
  };
}

function areaRecord(
  area: WorldArea,
  source: WorldData['source'],
  category: 'area' | 'water',
): WorldInspectionRecord {
  const kind = area.kind || category;
  return {
    id: area.id,
    category,
    title: kind.replaceAll('_', ' '),
    source,
    properties: { kind },
  };
}
