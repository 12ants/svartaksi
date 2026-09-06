/**
 * Interprets MapLibre/OpenFreeMap vector tiles as WorldData: which features are roads,
 * which polygons are ground, and how the same building arriving from two tiles is
 * reduced to one. Fetching and decoding the tiles themselves is vectorTileSource.ts.
 */
import {
  getChunkKeys,
  getCorridorChunkKeys,
  lngLatToLocal,
  ringCentroid,
  smoothPolyline,
  withinLocalCorridor,
  withinLocalRadius,
} from '../geo';
import { mergeWithPreview } from '../normalize';
import { isRenderedWay } from '../../svartaksi/roadStyle';
import type {
  LngLat,
  LocalPoint,
  WorldBuilding,
  WorldData,
  WorldDataCorridor,
  WorldDataProvider,
  WorldDataRadius,
} from '../types';
import { normalizeBuildingAppearance } from '../normalizeAppearance';
import { normalizeRoadStructure } from '../roadElevationProfile';
import { fetchTileFeatures, type MapLibreFeature } from './vectorTileSource';

export type { MapLibreFeature } from './vectorTileSource';

export const decodeMapLibreTerrain = (red: number, green: number, blue: number): number =>
  -10_000 + (red * 65_536 + green * 256 + blue) * 0.1;

/**
 * Vector tiles carry a buffer of geometry past their own edge, so a building close to a
 * tile boundary is emitted *complete* by both neighboring tiles. Rendered naively that
 * building gets two identical, exactly coplanar sets of facades and one roof stacked on
 * another — doubled fragment cost, and every wall fighting its own copy for the same
 * depth values.
 *
 * Where both copies are complete they are identical — same vertex count, same height,
 * same position — which is what this key matches on.
 */
function footprintKey(rings: LocalPoint[][], height: number): string {
  const ring = rings[0] ?? [];
  const centroid = ringCentroid(ring);
  return [
    ring.length,
    height.toFixed(1),
    (Math.round(centroid.x * 2) / 2).toFixed(1),
    (Math.round(centroid.z * 2) / 2).toFixed(1),
  ].join(':');
}

/** How far apart two copies of one seam building's centroid can land. Clipping the ring
 * at the tile edge moves it by a metre or two; anything further apart is two buildings. */
const SEAM_COPY_RADIUS = 6;

/**
 * The other half of the seam problem: the owning tile clips the building at its edge
 * while the neighbor carries it whole, so the two rings differ in vertex count and their
 * centroids land a metre or two apart. `footprintKey` cannot see that, and the survivors
 * are near-coplanar walls fighting for the same depth values — a stipple of z-fighting
 * across facades near any tile seam.
 *
 * Proximity alone would risk merging real neighbors in a dense terrace, so this also
 * requires the source feature id and height to agree. Two tiles describing the same OSM
 * building agree on both; a terrace neighbor carries its own id.
 *
 * The copies must also come from *different* tiles. Within one tile a shared feature id
 * means the parts of a single MultiPolygon — a courtyard block, a building with a
 * detached wing — which are distinct geometry that must both render.
 */
function isSeamCopy(
  placed: PlacedBuilding,
  candidate: PlacedBuilding,
): boolean {
  if (placed.tile === candidate.tile) return false;
  if (placed.featureId !== candidate.featureId) return false;
  if (Math.abs(placed.height - candidate.height) > 0.5) return false;
  return Math.hypot(placed.centroid.x - candidate.centroid.x, placed.centroid.z - candidate.centroid.z)
    <= SEAM_COPY_RADIUS;
}

interface PlacedBuilding {
  tile: string;
  featureId: string;
  height: number;
  centroid: LocalPoint;
}

// Widened from OSM's nominal lane widths so driving reads comfortably at this game's
// scale — footpaths (not drivable) are left at their original narrow width.
const widths: Record<string, number> = { motorway: 18, trunk: 16, primary: 14, secondary: 12, tertiary: 10, street: 9, service: 5, path: 2 };

/**
 * Vector-tile layers decoded into `WorldData.parks`/`water`.
 *
 * `landcover` and `park` were being fetched by nobody and are where most of the ground
 * variety actually lives: `landcover` carries wood, grass, wetland, sand, farmland and
 * ice as distinct classes, and `park` carries protected areas. Without them everything
 * outside a mapped `landuse` polygon rendered as bare default ground, and the forests
 * that cover most of Svartaksi did not exist as far as the renderer was concerned.
 */
const AREA_LAYERS = new Set(['water', 'landuse', 'landcover', 'park']);

/**
 * OpenMapTiles class names that mean the same ground as an OSM tag the renderer already
 * knows, under a different word. Mapping them here keeps every source speaking one
 * vocabulary, so threeWorld's palette and vegetation.ts's species table only ever have
 * to know OSM's names.
 */
const AREA_KIND_ALIASES: Record<string, string> = {
  national_park: 'park',
  protected_area: 'park',
  nature_reserve: 'wood',
  wood: 'wood',
  ice: 'ice',
};

/**
 * OpenMapTiles `poi` classes that mean "a shop or a bar with a lit frontage", which is
 * what neonSigns.ts hangs a sign on. Deliberately the *retail and nightlife* end of the
 * POI table only: an office, a school or a bus stop is a POI too, and putting neon over
 * those turns a residential street into Times Square.
 */
const STOREFRONT_CLASSES = new Set([
  'shop', 'grocery', 'clothing_store', 'department_store', 'alcohol_shop', 'bakery',
  'books', 'butcher', 'florist', 'furniture', 'jewelry_store', 'optician', 'shoe',
  'bar', 'beer', 'nightclub', 'restaurant', 'fast_food', 'cafe', 'ice_cream',
  'cinema', 'theatre', 'pharmacy', 'hairdresser', 'marketplace', 'lodging',
]);

/** True if a POI feature is a storefront, by either of the two fields OpenMapTiles
 * splits its taxonomy across (`class` is the coarse group, `subclass` the OSM tag). */
export function isStorefrontPoi(props: Record<string, unknown>): boolean {
  return STOREFRONT_CLASSES.has(String(props.class ?? '').toLowerCase())
    || STOREFRONT_CLASSES.has(String(props.subclass ?? '').toLowerCase());
}

function areaKind(props: Record<string, unknown>, layer: string): string {
  const raw = String(props.class ?? props.type ?? props.subclass ?? layer).toLowerCase();
  return AREA_KIND_ALIASES[raw] ?? raw;
}

/** Fetches up to this many nearest tiles for the (much wider) terrain radius — raised
 * from a flat 16 so the bigger area actually gets covered, still bounded to keep a
 * streaming update's network cost reasonable. */
const MAX_TILE_FETCHES = 32;

/** A corridor is a thin ribbon rather than a disc, so it can afford more tiles than a
 * radial fetch before it costs the same — and it needs them, since a long route crosses
 * more tiles end to end than a stream update covers in every direction. */
const MAX_CORRIDOR_TILE_FETCHES = 48;

/** Zoom the world is built from. OpenFreeMap's planet tiles top out here, and it is the
 * first zoom that carries residential streets — the ones routes actually terminate on. */
const TILE_ZOOM = 14;

/** Tiles to fetch for one load: the route ribbon when the caller asked for a corridor,
 * otherwise the disc around `center`. */
function tileKeysFor(center: LngLat, radius: WorldDataRadius, corridor?: WorldDataCorridor) {
  if (corridor) {
    return getCorridorChunkKeys(corridor.from, corridor.to, corridor.padMeters, TILE_ZOOM)
      .slice(0, MAX_CORRIDOR_TILE_FETCHES);
  }
  return getChunkKeys(center, radius.terrain, TILE_ZOOM).slice(0, MAX_TILE_FETCHES);
}

interface NormalizeAccumulator {
  roads: WorldData['roads'];
  buildings: WorldData['buildings'];
  water: WorldData['water'];
  parks: WorldData['parks'];
  labels: WorldData['labels'];
  objects: WorldData['objects'];
  seen: Set<string>;
  footprints: Set<string>;
  /**
   * Buildings already placed, bucketed by source feature id.
   *
   * A flat array scanned with `.some(isSeamCopy)` is quadratic, and a real snapshot is
   * not small: Svartaksi's opening fetch normalizes 9 795 building polygons, so that scan was
   * ~48 million comparisons and about four seconds of main-thread work — most of the time
   * spent between the tiles landing and the geometry build starting. `isSeamCopy` already
   * requires the two copies to carry the *same* feature id, so bucketing on it drops the
   * scan to the handful of polygons that could possibly match without changing which
   * copies are recognised.
   */
  placedBuildings: Map<string, PlacedBuilding[]>;
}

function createAccumulator(): NormalizeAccumulator {
  return {
    roads: [], buildings: [], water: [], parks: [], labels: [], objects: [],
    seen: new Set(), footprints: new Set(), placedBuildings: new Map(),
  };
}

function finishAccumulator(acc: NormalizeAccumulator): Omit<WorldData, 'source'> {
  return {
    roads: acc.roads, buildings: acc.buildings, water: acc.water, parks: acc.parks,
    labels: acc.labels.slice(0, 500), objects: acc.objects,
  };
}

/** One feature's worth of the normalize work, shared by the plain (small, test-facing)
 * pass and the yielding one the real provider uses — see normalizeMapLibreFeaturesInSlices. */
function absorbFeature(acc: NormalizeAccumulator, feature: MapLibreFeature, index: number, origin: LngLat): void {
  const id = `maplibre:${feature.layer}:${feature.tile ?? ''}:${feature.id ?? index}`;
  if (acc.seen.has(id)) return;
  acc.seen.add(id);
  const props = feature.properties;
  if (feature.layer === 'transportation' && (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') && isRenderedWay(String(props.class ?? props.type ?? 'street'), props)) {
    const kind = String(props.class ?? props.type ?? 'street');
    const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const { structure, layer } = normalizeRoadStructure(props);
    lines.forEach((line, lineIndex) => acc.roads.push({
      id: `${id}:${lineIndex}`,
      kind,
      width: widths[kind] ?? 6,
      points: smoothPolyline(line.map(([lng, lat]) => lngLatToLocal(origin, { lng, lat }))),
      structure,
      layer,
    }));
    if (typeof props.name === 'string' && lines[0]?.length) {
      const point = lines[0][Math.floor(lines[0].length / 2)];
      acc.labels.push({ id: `${id}:label`, text: props.name, category: 'Road', detail: kind, point: lngLatToLocal(origin, { lng: point[0], lat: point[1] }) });
    }
  } else if (feature.layer === 'building' && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const value = Number(props.height ?? props.render_height ?? 12);
    const height = Number.isFinite(value) ? Math.max(3, Math.min(value, 350)) : 12;
    const featureId = String(feature.id ?? index);
    polygons.forEach((polygon, polygonIndex) => {
      const rings = polygon.map((ring) => ring.map(([lng, lat]) => lngLatToLocal(origin, { lng, lat })));
      // One building, one set of facades — see footprintKey and isSeamCopy.
      const key = footprintKey(rings, height);
      if (acc.footprints.has(key)) return;
      const candidate: PlacedBuilding = {
        tile: feature.tile ?? '',
        featureId,
        height,
        centroid: ringCentroid(rings[0] ?? []),
      };
      const sameFeature = acc.placedBuildings.get(featureId);
      if (sameFeature?.some((placed) => isSeamCopy(placed, candidate))) return;
      acc.footprints.add(key);
      if (sameFeature) sameFeature.push(candidate);
      else acc.placedBuildings.set(featureId, [candidate]);
      acc.buildings.push({
        id: `${id}:${polygonIndex}`,
        height,
        rings,
        properties: {
          ...props,
          type: String(props.type ?? props.class ?? 'residential').toLowerCase(),
          class: String(props.class ?? props.type ?? 'residential').toLowerCase(),
        },
        appearance: normalizeBuildingAppearance(props),
      });
    });
  } else if (AREA_LAYERS.has(feature.layer) && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    polygons.forEach((polygon, polygonIndex) => {
      const area = { id: `${id}:${polygonIndex}`, kind: areaKind(props, feature.layer), rings: polygon.map((ring) => ring.map(([lng, lat]) => lngLatToLocal(origin, { lng, lat }))) };
      if (feature.layer === 'water') acc.water.push(area); else acc.parks.push(area);
    });
  } else if (feature.layer === 'poi' && feature.geometry.type === 'Point') {
    const point = lngLatToLocal(origin, { lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] });
    if (props.entrance || props.door) acc.objects.push({ id, kind: 'entrance', point, properties: props });
    if (isStorefrontPoi(props)) acc.objects.push({ id: `${id}:storefront`, kind: 'storefront', point, properties: props });
    if (typeof props.name === 'string') {
      acc.labels.push({ id, text: props.name, category: 'POI', detail: String(props.class ?? props.subclass ?? 'place'), point });
    }
  }
}

export function normalizeMapLibreFeatures(features: MapLibreFeature[], origin: LngLat): Omit<WorldData, 'source'> {
  const acc = createAccumulator();
  features.forEach((feature, index) => absorbFeature(acc, feature, index, origin));
  return finishAccumulator(acc);
}

/** How long a slice of normalizing may run before it hands the main thread back —
 * roughly the same order as buildScheduler's per-frame budget, since this runs ahead of
 * that stage in the same pipeline and the two together must still fit a frame. */
const NORMALIZE_SLICE_BUDGET_MS = 6;

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Same result as normalizeMapLibreFeatures, but for a fetch of up to 48 tiles' worth of
 * features rather than a unit test's handful. `forEach` over every one of them — the lng/
 * lat conversions, `smoothPolyline`, and the O(n) seam-copy scan per building — used to run
 * as a single uninterrupted block on the main thread between the tiles arriving and the
 * (already sliced) geometry build starting, which is what a driving stutter each time new
 * tiles streamed in actually was. Slicing this stage the same way buildScheduler slices
 * the next one removes it without changing what gets built.
 */
const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export async function normalizeMapLibreFeaturesInSlices(
  features: MapLibreFeature[],
  origin: LngLat,
  signal: AbortSignal,
  now: () => number = defaultNow,
): Promise<Omit<WorldData, 'source'>> {
  const acc = createAccumulator();
  let deadline = now() + NORMALIZE_SLICE_BUDGET_MS;
  for (let index = 0; index < features.length; index += 1) {
    absorbFeature(acc, features[index], index, origin);
    if (now() < deadline) continue;
    await yieldToBrowser();
    // A load superseded while parked at a yield point should stop here rather than
    // build a WorldData nobody will ever render — the same contract fetchTileFeatures
    // already gives its own callers.
    if (signal.aborted) throw signal.reason;
    deadline = now() + NORMALIZE_SLICE_BUDGET_MS;
  }
  return finishAccumulator(acc);
}

export interface BuildingClipArea {
  /** Always required as the radius fallback, even when `corridor` is set — see
   * withinLocalRadius/withinLocalCorridor. */
  center: LocalPoint;
  corridor: { from: LocalPoint; to: LocalPoint } | null;
  /** `radius.buildings` is what keeps a routing-only corridor fetch cheap: a route only
   * needs roads, so that caller asks for a nominal radius here and everything else is
   * dropped rather than carried into a WorldData nobody renders. A corridor meant to be
   * rendered (a bus's own route) asks for a real one instead. */
  radiusMeters: number;
}

/** Clips a fetch's buildings down to the area a caller actually asked to render: a disc
 * around `center`, or — when `corridor` is given — the ribbon along it instead. Tiles
 * bundle every layer together, so this is the only point a provider can apply the
 * tighter building-specific area a wider roads/terrain fetch already covers. */
export function clipBuildingsToArea(buildings: WorldBuilding[], area: BuildingClipArea): WorldBuilding[] {
  return buildings.filter((building) => {
    const centroid = ringCentroid(building.rings[0] ?? []);
    return area.corridor
      ? withinLocalCorridor(centroid, area.corridor.from, area.corridor.to, area.radiusMeters)
      : withinLocalRadius(centroid, area.center, area.radiusMeters);
  });
}

export function createMapLibreProvider(): WorldDataProvider {
  return {
    source: 'maplibre',
    async load(center, radius, signal, origin = center, corridor, priority = corridor ? 'background' : 'foreground'): Promise<WorldData> {
      // Tiles bundle every layer together, so there's no way to poll roads/terrain and
      // buildings from separate areas at the fetch level — fetch the wider terrain area
      // once, then clip buildings back down to their own tighter radius below.
      //
      // A corridor defaults to background work: it usually plans a route, while a radial
      // load is the world the player is sitting and waiting for. Letting the two compete
      // evenly for connections is what made the opening world take three times as long to
      // arrive as it needed to. A caller streaming a corridor onto the screen itself (the
      // bus's own route, a leg ahead) passes `priority: 'foreground'` to opt back in.
      const features = await fetchTileFeatures(
        tileKeysFor(center, radius, corridor),
        signal,
        priority,
      );
      const normalized = await normalizeMapLibreFeaturesInSlices(features, origin, signal);
      const centerLocal = lngLatToLocal(origin, center);
      const corridorLocal = corridor
        ? { from: lngLatToLocal(origin, corridor.from), to: lngLatToLocal(origin, corridor.to) }
        : null;
      return mergeWithPreview('maplibre', {
        ...normalized,
        buildings: clipBuildingsToArea(normalized.buildings, {
          center: centerLocal,
          corridor: corridorLocal,
          radiusMeters: radius.buildings,
        }),
      });
    },
  };
}
