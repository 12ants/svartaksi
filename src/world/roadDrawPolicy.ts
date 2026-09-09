import { getRoadFamily } from '../svartaksi/roadStyle';

/**
 * How much road work a build actually has to do: which roads are worth painting at all,
 * and how the painting loop is cut into slices.
 *
 * Both halves exist because the road phase is the largest block of straight-line work in
 * a world build, and both were previously decided by a rule that ignored what the work
 * costs. Roads were painted out to one flat radius regardless of class, and the loop
 * yielded every N *roads* regardless of how big those roads were.
 *
 * Pure arithmetic — no three.js, no scene, no world data beyond a road's own class and
 * point count — so the decisions here are testable without a canvas, per the project's
 * pure-first rule. `threeWorld.ts` binds them.
 */

/**
 * The classes a long draw distance is wasted on: the whole `path` family (footpaths,
 * cycleways, steps, tracks) plus `service` (the back lanes and park drives left after
 * `isRenderedWay` has already dropped driveways and parking aisles as clutter).
 *
 * Deliberately expressed through `getRoadFamily` rather than a table of class names of
 * its own. An earlier draft of this module duplicated `ROAD_LAYER`'s key list, which
 * turned out to name classes the tile data does not actually use — the source is
 * OpenMapTiles, whose `transportation` layer emits `path`, `service` and `minor`, not
 * `footway`/`residential`/`street`. Reusing the taxonomy the rest of the codebase
 * already decides road appearance with means this cull cannot drift away from it.
 *
 * `minor` — OpenMapTiles' residential/unclassified street — is *not* culled early.
 * Residential streets are what make a city read as a grid rather than a few arterials
 * floating in fog, and they are wide enough to resolve at distance.
 */

/**
 * How far a minor road is painted, in metres.
 *
 * Derived from the fog, not chosen by eye. `fogDensityFor` (renderOptions.ts) sets
 * FogExp2 density to `1.9 / buildingDistance`, clamped to [0.0016, 0.0042]. The thinnest
 * fog this project can produce therefore comes from the largest building distance —
 * the `high` tier's 650m, since the render-budget scale only ever pulls that number
 * down — giving density 1.9/650 = 0.00292. FogExp2 opacity is `1 - exp(-(d * density)^2)`,
 * so at 900m that is 1 - exp(-(900 * 0.00292)^2) = 0.999.
 *
 * A minor road beyond this radius contributes at most about a tenth of one percent of
 * its own colour to the frame, in the least foggy configuration that exists. Every
 * tier below `high` fogs it out sooner still. Painting it is work with no visible result.
 *
 * The floor matters as much as the number: this must never fall below the largest
 * `buildingDistance` (650m), because street lights, traffic signals, bus stops and post
 * boxes are placed against roads re-filtered to *that* radius. Keeping the paint radius
 * above it guarantees every road those props stand on is still painted, so a lamp can
 * never end up lighting a road that was culled out from under it. Both bounds are
 * asserted in this module's tests.
 */
export const MINOR_ROAD_PAINT_DISTANCE = 900;

/** True for the narrow, numerous classes described by `MINOR_ROAD_MAX_PROMINENCE`. */
export function isMinorRoadKind(kind: string): boolean {
  return getRoadFamily(kind) === 'path' || kind === 'service';
}

/**
 * The radius a road of this class should be painted to, given the build's full terrain
 * radius.
 *
 * Major roads keep the whole terrain radius: seeing an arterial run away to the horizon
 * down a straight line of sight is the reason roads are distance-culled rather than
 * frustum-culled in the first place, and shortening that would be visible immediately.
 *
 * The minor radius is clamped to the terrain radius so a caller that hands in a smaller
 * world than the fog assumes can never widen the cull instead of narrowing it.
 */
export function roadPaintDistance(kind: string, terrainDistance: number): number {
  if (!isMinorRoadKind(kind)) return terrainDistance;
  return Math.min(terrainDistance, MINOR_ROAD_PAINT_DISTANCE);
}

/**
 * Points of road geometry to build between two yields of the road loop.
 *
 * The loop used to yield every 8 roads, which assumes every road costs the same. They do
 * not: `buildRoadGeometry` walks a road's polyline and emits vertices per point, so an
 * OSM way is anywhere from a 2-point straight stub to a several-hundred-point ring road.
 * Eight of the former is a trivial slice; eight of the latter is the kind of long slice
 * the build scheduler exists to prevent, and no road-count cadence can tell the two apart.
 *
 * Counting points instead makes a slice's size track its actual cost, so slice duration
 * stays roughly even whatever mix of road lengths a tile happens to contain. The budget
 * is a work quantum, not a time target — the scheduler still checks its own millisecond
 * deadline between slices, and this only controls how finely it is *able* to stop.
 *
 * 128 points is about sixteen typical short ways, keeping the common case near the
 * old 8-road cadence while capping the pathological one.
 */
export const ROAD_GEOMETRY_POINT_BUDGET = 128;

/**
 * Accumulates road sizes and reports when a slice's point budget is spent.
 *
 * A road is never split: `buildRoadGeometry` has to see a whole polyline to miter it, so
 * the boundary can only fall between roads. This overshoots by at most one road's worth
 * of points, which is the finest granularity available without changing that.
 */
export function createRoadSliceBudget(budgetPoints: number = ROAD_GEOMETRY_POINT_BUDGET) {
  let spent = 0;
  return {
    /** Charges `points` to the current slice; true when the budget is spent and the
     * caller should yield. Resets on each boundary so the next slice starts full. */
    shouldYieldAfter(points: number): boolean {
      spent += Math.max(0, points);
      if (spent < budgetPoints) return false;
      spent = 0;
      return true;
    },
    /** Points charged to the slice currently being accumulated. For tests and
     * diagnostics; a caller driving the loop only needs `shouldYieldAfter`. */
    pending(): number {
      return spent;
    },
  };
}
