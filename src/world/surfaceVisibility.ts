/**
 * Decides whether a road's surface should be *drawn*, as distinct from whether it
 * belongs in `WorldData` at all — see backlog item 9, and `isRenderedWay`
 * (`../svartaksi/roadStyle.ts`) for the inclusion side of that split, which this module no
 * longer shares a decision with.
 *
 * A road that is invisible from the surface — a tunnel, a road running under something
 * else entirely — still has to exist for routing (a bus, a route search) to cross it, but
 * drawing its surface paints a road ribbon over whatever is actually on top of it: a park,
 * a lake, another road's own deck. This function is the single place that decision is
 * made, off the normalized `structure`/`layer` fields `roadElevationProfile.ts`'s
 * `normalizeRoadStructure` already attaches to every `WorldRoad` at the provider
 * boundary — nothing here re-reads raw OSM tags.
 */
import { structureInfo } from './roadElevationProfile';
import type { WorldRoad } from './types';

export type SurfaceVisibility = 'visible' | 'hidden';

/**
 * Pure function of a road's own normalized structure/layer — no lookup, no I/O, safe to
 * call per-road on every build.
 *
 * - `bridge` is always visible: a bridge deck is exactly what a surface renderer should
 *   draw, and nothing else in the world sits above it to be occluded by drawing it.
 * - `tunnel` is always hidden: this world has no cut/portal geometry (deferred by backlog
 *   item 8 alongside deck/pier meshes), so there is no open surface to draw a tunnel's
 *   road as — drawing the tunnel ribbon anyway would paint it across whatever ground,
 *   water or building sits over the top of it.
 * - `ground`/`ford` on a negative `layer` is the "fully covered" / underpass case: the
 *   OSM tags carry ordering evidence (something else passes over this road) but not a
 *   structure tag of their own, and — same as tunnels — this renderer has no open-surface
 *   geometry to draw an underpass's carriageway into yet. The conservative fallback is to
 *   hide it rather than guess a surface that does not exist. Once open-surface geometry
 *   for underpasses is built, this is the one branch that changes.
 * - `ground`/`ford` at `layer >= 0` is the overwhelming default case: an ordinary
 *   at-grade road, always visible.
 */
export function surfaceVisibility(road: Pick<WorldRoad, 'structure' | 'layer'>): SurfaceVisibility {
  const { structure, layer } = structureInfo(road);
  if (structure === 'bridge') return 'visible';
  if (structure === 'tunnel') return 'hidden';
  return layer < 0 ? 'hidden' : 'visible';
}

/**
 * The one call site actually gates drawing on: `surfaceVisibility` plus the explicit
 * debug/editor override (see `RenderOptions.debugShowHiddenRoads` and `devMode.ts`) —
 * never exposed through normal gameplay, only behind the `?dev=1` gate the developer
 * panel itself already sits behind.
 */
export function isSurfaceVisible(
  road: Pick<WorldRoad, 'structure' | 'layer'>,
  options: { debugShowHiddenRoads?: boolean } = {},
): boolean {
  return options.debugShowHiddenRoads === true || surfaceVisibility(road) === 'visible';
}
