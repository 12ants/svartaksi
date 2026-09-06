/** Local flat-earth projection (meters around an origin point) and slippy-map tile math. */
import type { ChunkKey, LngLat, LocalPoint } from './types';

const EARTH_RADIUS = 6_378_137;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Converts lng/lat to meters on a local flat plane centered at `origin` — an
 * equirectangular approximation, not a true projection. It's only accurate near
 * `origin`; the `Math.cos(origin.lat)` term corrects for longitude lines
 * converging toward the poles (a degree of longitude is a shorter distance at
 * higher latitudes), evaluated once at the origin rather than per-point, so
 * distortion grows slowly with distance from it. Fine for a world that streams
 * in around a car; do not reuse this for anything that needs to stay accurate
 * across a whole country.
 *
 * z is negated (north = -z) to match Three.js's right-handed convention as used
 * throughout this renderer: +x east, +z south, +y up.
 */
export function lngLatToLocal(origin: LngLat, point: LngLat): LocalPoint {
  return {
    x: (point.lng - origin.lng) * DEG_TO_RAD * EARTH_RADIUS * Math.cos(origin.lat * DEG_TO_RAD),
    z: -(point.lat - origin.lat) * DEG_TO_RAD * EARTH_RADIUS,
  };
}

/** Inverse of lngLatToLocal — same flat-plane approximation, same accuracy caveat. */
export function localToLngLat(origin: LngLat, point: LocalPoint): LngLat {
  return {
    lng: origin.lng + point.x / (DEG_TO_RAD * EARTH_RADIUS * Math.cos(origin.lat * DEG_TO_RAD)),
    lat: origin.lat - point.z / (DEG_TO_RAD * EARTH_RADIUS),
  };
}

/** Standard Web Mercator (slippy-map/XYZ) tile index for a point at a given zoom
 * level — the same scheme MapLibre/OpenFreeMap and most other web map tile
 * servers use. `Math.asinh(Math.tan(latRad))` is the inverse Gudermannian
 * function; it's what makes Mercator's vertical (y) axis logarithmic instead of
 * linear in latitude. Latitude is clamped to ±85.05° because Mercator's y value
 * diverges to infinity at the poles — that clamp is the actual bound of the
 * standard projection, not an arbitrary safety margin. */
export function lngLatToTile(point: LngLat, zoom: number): ChunkKey {
  const scale = 2 ** zoom;
  const { x, y } = fractionalTile(point, zoom);
  return {
    z: zoom,
    x: ((Math.floor(x) % scale) + scale) % scale,
    y: Math.max(0, Math.min(scale - 1, Math.floor(y))),
  };
}

/** Same Web Mercator mapping as lngLatToTile without the floor — the corridor search
 * below needs sub-tile positions to measure distance to a route line. */
function fractionalTile(point: LngLat, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (1 - Math.asinh(Math.tan(latitude * DEG_TO_RAD)) / Math.PI) / 2 * scale,
  };
}

/** Ground meters one tile spans at this latitude and zoom. Only ever used to convert a
 * meter budget into a tile-grid reach, so the small-angle approximation is fine. */
function metersPerTile(latitude: number, zoom: number): number {
  return Math.cos(latitude * DEG_TO_RAD) * 2 * Math.PI * EARTH_RADIUS / 2 ** zoom;
}

/** Squared distance from a point to a segment, all in tile-grid units. */
function pointToSegmentSquared(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = px - (ax + dx * t);
  const cy = py - (ay + dy * t);
  return cx * cx + cy * cy;
}

/**
 * Every tile within `padMeters` of the straight line from `from` to `to`, ordered from
 * `from` outward along the route.
 *
 * The order matters when a caller's fetch cap trims the list: what survives should be
 * the near end of the journey, complete, rather than a scattering of tiles the whole
 * way along with holes between them. Ties (two tiles equidistant from the start) break
 * toward the one nearer the route line.
 *
 * A long bus route is a *line*, not a disc: covering a 6 km corridor with getChunkKeys
 * means a disc wide enough to reach both ends, which is an order of magnitude more
 * tiles than the route actually crosses — and once a fetch cap trims that disc, the
 * tiles it keeps are the ones around the midpoint, so both endpoints end up missing
 * exactly the roads the route has to start and finish on. This selects the ribbon
 * instead: complete coverage of the corridor at a fraction of the requests.
 */
export function getCorridorChunkKeys(
  from: LngLat,
  to: LngLat,
  padMeters: number,
  zoom: number,
): ChunkKey[] {
  const scale = 2 ** zoom;
  const start = fractionalTile(from, zoom);
  const end = fractionalTile(to, zoom);
  // Half a tile's diagonal, so a tile whose *centre* is just outside the pad but whose
  // area still overlaps the corridor is kept rather than punching a hole in it.
  const reach = padMeters / metersPerTile((from.lat + to.lat) / 2, zoom) + Math.SQRT1_2;
  const minX = Math.floor(Math.min(start.x, end.x) - reach);
  const maxX = Math.floor(Math.max(start.x, end.x) + reach);
  const minY = Math.max(0, Math.floor(Math.min(start.y, end.y) - reach));
  const maxY = Math.min(scale - 1, Math.floor(Math.max(start.y, end.y) + reach));

  const keys: Array<ChunkKey & { toLine: number; toStart: number }> = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      const toLine = pointToSegmentSquared(centerX, centerY, start.x, start.y, end.x, end.y);
      if (toLine > reach * reach) continue;
      keys.push({
        z: zoom,
        x: ((x % scale) + scale) % scale,
        y,
        toLine,
        toStart: (centerX - start.x) ** 2 + (centerY - start.y) ** 2,
      });
    }
  }

  return keys
    .sort((a, b) => a.toStart - b.toStart || a.toLine - b.toLine)
    .map(({ z, x, y }) => ({ z, x, y }));
}

/**
 * Every tile within `radiusMeters` of `center` at `zoom`, nearest-first — the
 * caller (a provider fetching vector tiles) can start rendering/streaming the
 * closest data first and cut the list short under a fetch budget without
 * leaving a hole right around the player. `dx`/`dy` are tile-grid offsets, not
 * meters, so `reach` (how many tiles out to search) is derived from an estimate
 * of meters-per-tile at this latitude/zoom — that estimate only needs to be
 * roughly right, since it just bounds the search square, not the actual
 * distance sort.
 */
export function getChunkKeys(center: LngLat, radiusMeters: number, zoom: number): ChunkKey[] {
  const centerKey = lngLatToTile(center, zoom);
  const reach = Math.max(1, Math.ceil(radiusMeters / metersPerTile(center.lat, zoom)));
  const scale = 2 ** zoom;
  const keys: Array<ChunkKey & { distance: number }> = [];

  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const y = centerKey.y + dy;
      if (y < 0 || y >= scale) continue;
      keys.push({
        z: zoom,
        x: ((centerKey.x + dx) % scale + scale) % scale,
        y,
        distance: dx * dx + dy * dy,
      });
    }
  }

  return keys
    .sort((a, b) => a.distance - b.distance || a.x - b.x || a.y - b.y)
    .map(({ z, x, y }) => ({ z, x, y }));
}

/** A [south, west, north, east] lat/lng bounding box `radiusMeters` around
 * `center` — the shape Overpass's bounding-box query syntax expects. */
export function boundsAround(center: LngLat, radiusMeters: number): [number, number, number, number] {
  const latDelta = radiusMeters / (EARTH_RADIUS * DEG_TO_RAD);
  const lngDelta = latDelta / Math.cos(center.lat * DEG_TO_RAD);
  return [center.lat - latDelta, center.lng - lngDelta, center.lat + latDelta, center.lng + lngDelta];
}

/**
 * Even-odd ray crossing in the XZ plane: true if `point` is inside the ring.
 *
 * The `|| Number.EPSILON` guards the divide on a perfectly horizontal edge, which real
 * OSM rings do contain (any ring with two vertices at the same latitude).
 */
export function pointInRing(point: LocalPoint, ring: LocalPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index];
    const b = ring[previous];
    if (((a.z > point.z) !== (b.z > point.z))
      && point.x < ((b.x - a.x) * (point.z - a.z)) / ((b.z - a.z) || Number.EPSILON) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Axis-aligned extent of a ring in the local plane. Returns an inverted (empty) box for
 * an empty ring, so a containment test against it fails rather than passing everything. */
export function ringBounds(ring: readonly LocalPoint[]): {
  minX: number; maxX: number; minZ: number; maxZ: number;
} {
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
  return { minX, maxX, minZ, maxZ };
}

/** Squared distance from `(x, z)` to the segment `a`-`b`, on the local flat plane.
 * Squared because every caller either compares it against another squared distance or
 * takes one square root at the end of a loop. */
export function pointSegmentDistanceSquared(
  x: number, z: number, a: LocalPoint, b: LocalPoint,
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0
    : Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
  const cx = x - (a.x + dx * t);
  const cz = z - (a.z + dz * t);
  return cx * cx + cz * cz;
}

/** True if `point` lies within `radiusMeters` of `center` on the local flat plane — used
 * to clip a data category (buildings) to a tighter radius than the wider area a provider
 * polled for another category (roads/terrain); see WorldDataRadius. */
export function withinLocalRadius(point: LocalPoint, center: LocalPoint, radiusMeters: number): boolean {
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  return dx * dx + dz * dz <= radiusMeters * radiusMeters;
}

/** The corridor analogue of withinLocalRadius: true if `point` lies within `radiusMeters`
 * of the segment `from`-`to` on the local flat plane, rather than of a single centre —
 * used to clip a data category to a ribbon along a route instead of a disc around one
 * point when a provider was asked for a WorldDataCorridor. */
export function withinLocalCorridor(point: LocalPoint, from: LocalPoint, to: LocalPoint, radiusMeters: number): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared));
  const nearestX = point.x - (from.x + dx * t);
  const nearestZ = point.z - (from.z + dz * t);
  return nearestX * nearestX + nearestZ * nearestZ <= radiusMeters * radiusMeters;
}

/**
 * Turn angle at a vertex, in radians, below which the vertex is treated as part of a
 * straight run and left alone. Roughly 4.5 degrees: well under what reads as a bend at
 * driving distance, and comfortably above the sub-degree wobble that tile coordinate
 * quantization puts into an otherwise dead-straight street.
 */
const SMOOTH_CORNER_THRESHOLD = Math.cos(0.08);

/**
 * Corner-cutting (Chaikin, applied per vertex rather than per edge): a vertex that turns
 * is replaced by two points a quarter of the way back along each of its adjacent edges,
 * so the sharp, angular bends raw OSM/vector-tile polylines have — sampled sparsely at
 * the source — read as an actual curved road from a moving camera rather than a chain of
 * straight segments. No overshoot risk, unlike a spline fit (Catmull-Rom) on tight
 * real-world bends. The first and last point are never moved, so roads still meet
 * exactly at shared junctions.
 *
 * Vertices that don't turn (see SMOOTH_CORNER_THRESHOLD) pass through untouched instead
 * of being split. Classic edge-wise Chaikin doubles *every* polyline, and the large
 * majority of vertices in real road data sit on a straight run — subdividing those buys
 * nothing visually while multiplying ribbon geometry, build time and, downstream, the
 * size of the graph the bus routes over. Cutting only real corners keeps the identical
 * look at a fraction of the vertex count.
 *
 * Two passes (the default) round a bend noticeably more than one; each pass turns one
 * corner into two gentler ones, so a corner converges toward a circular arc.
 */
export function smoothPolyline(points: LocalPoint[], passes = 2): LocalPoint[] {
  let current = points;
  for (let pass = 0; pass < passes; pass += 1) {
    if (current.length < 3) break;
    const smoothed: LocalPoint[] = [current[0]];
    for (let index = 1; index < current.length - 1; index += 1) {
      const previous = current[index - 1];
      const vertex = current[index];
      const next = current[index + 1];
      const inX = vertex.x - previous.x;
      const inZ = vertex.z - previous.z;
      const outX = next.x - vertex.x;
      const outZ = next.z - vertex.z;
      const inLength = Math.hypot(inX, inZ);
      const outLength = Math.hypot(outX, outZ);
      // A zero-length edge has no direction to compare, so there is no corner to cut.
      const straight = inLength < 1e-9 || outLength < 1e-9
        || (inX * outX + inZ * outZ) / (inLength * outLength) >= SMOOTH_CORNER_THRESHOLD;
      if (straight) {
        smoothed.push(vertex);
        continue;
      }
      smoothed.push(
        { x: vertex.x - inX * 0.25, z: vertex.z - inZ * 0.25 },
        { x: vertex.x + outX * 0.25, z: vertex.z + outZ * 0.25 },
      );
    }
    smoothed.push(current[current.length - 1]);
    current = smoothed;
  }
  return current;
}

/** Unweighted centroid of a ring's vertices — good enough to test a building footprint
 * against a radius without full polygon-area math (see describeFootprint in
 * facadeRecords.ts for the precise, area-weighted version facade rendering needs). */
export function ringCentroid(ring: LocalPoint[]): LocalPoint {
  if (!ring.length) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const point of ring) { x += point.x; z += point.z; }
  return { x: x / ring.length, z: z / ring.length };
}
