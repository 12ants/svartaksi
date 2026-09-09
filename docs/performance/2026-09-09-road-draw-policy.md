# Road draw policy — class-aware paint radius and point-budgeted slices

Two changes to the road phase of a world build, both in response to "don't render so much
roads, and divide the work into smaller batches."

**Status: structural evidence only. No frame-time claim is made.** There is still no
hardware baseline (see [the 2026-09-06 baseline](2026-09-06-baseline.md)), so the
[performance plan](../plans/2026-09-06-performance-plan.md)'s stop rule applies: this is
correctness and work-shape work, and the numbers below count *geometry*, never FPS.

## 1. Minor roads are painted to a shorter, fog-derived radius

Roads were painted out to `MAX_TERRAIN_DRAW_DISTANCE` (1200m) regardless of class, while
the fog is tuned to reach ~97% opacity at the *building* distance (350–650m). Everything
between those two numbers is geometry built into fog thick enough to hide it.

`src/world/roadDrawPolicy.ts` cuts the `path` family and `service` roads to 900m and
leaves every other class at the full radius. 900m is derived, not tuned: the thinnest fog
this project can produce is density `1.9 / 650 = 0.00292`, and FogExp2 opacity
`1 - exp(-(900 * 0.00292)^2)` is 0.999. In the least foggy configuration that exists, such
a road contributes about a tenth of one percent of its own colour. Both the derivation and
the lower bound are asserted in the module's tests rather than left as prose.

Arterials keep the full radius deliberately — seeing a road run to the horizon down a
straight line of sight is why roads are distance-culled rather than frustum-culled at all.
`minor` (OpenMapTiles' residential/unclassified street) is above the cull line for the same
reason: it carries the readable street grid.

### Measured class distribution

Decoded from the 80 committed tiles in `vendor/worldcache`, after `isRenderedWay` has
already dropped non-physical ways and service clutter:

| Class | Ways | Polyline points |
|---|---:|---:|
| `path` (minor) | 4,420 | 132,006 |
| `service` (minor) | 974 | 20,912 |
| `track` (minor) | 80 | 1,212 |
| `minor` (street) | 2,902 | 32,702 |
| `tertiary` | 1,612 | 7,854 |
| `secondary` | 1,384 | 5,656 |
| `motorway` | 701 | 3,520 |
| everything else | 501 | 4,594 |

**Minor classes are 43.3% of ways but 73.9% of all road polyline points** — `path` alone
is 63% of them. Geometry cost tracks points, not ways, so this is where the road phase's
work actually is.

The saving is the share of those points falling in the 900–1200m annulus, which is 44% of
the disc's area. In a uniformly dense world that is roughly **a third of all road geometry
points no longer built per full-radius rebuild**. Real cities are not uniformly dense and
the camera is rarely centred in open ground, so treat this as an order-of-magnitude
structural estimate, not a measurement of any particular scene.

### Why this is confined to rendering

`visibleRoads` still feeds every placement stage (lamps, signals, bus stops, post boxes);
only the new `paintedRoads` set drives carriageway geometry. `nearbyRoads` — the input to
routing and to the physics elevation profiles — is untouched, so nothing a vehicle drives
on or a route search crosses has changed. The paint radius is guaranteed wider than every
tier's `buildingDistance`, which is the radius props are placed within, so a lamp can never
stand on a road that was culled from under it. That bound is a test, not a comment.

## 2. The road loop slices by points, not by road count

The loop yielded every 8 roads, which charges eight 2-point stubs and eight 300-point ring
roads identically. `buildRoadGeometry` emits vertices per point, so those are wildly
different slices, and no road-count cadence can tell them apart — the snapshot above shows
the spread is real (`path` averages 30 points a way, `motorway` 5).

`createRoadSliceBudget` accumulates polyline points and yields at 128, so slice size tracks
slice cost. A road is never split — mitering needs the whole polyline — so the boundary
still falls between roads and overshoots by at most one road. `estimateBuildSteps` counts
points for the road phase too, keeping the progress readout in step with the real cadence.

This changes how *finely* the scheduler is able to stop, not how long it runs for; it still
checks its own millisecond deadline between slices.

## Verification

`pnpm test:all` — 146 files, 1491 tests, all passing. `pnpm build` succeeds (the
pre-existing large-chunk warning is unchanged). 15 new tests cover the classification, the
fog derivation, the prop-placement lower bound, and the slice budget's boundary cases.

The class table above came from decoding the committed tiles through the project's own
`decodeVectorTile` in a throwaway test, which was deleted afterwards rather than left in
the suite — it asserts nothing and depends on the cache snapshot's contents.

## What is still unverified

Everything a browser would tell you. Whether the shorter radius is visible at any tier,
whether the point budget actually flattens the slice histogram, and whether either shows up
in frame time are all open, and need the paired captures Task 1 of the performance plan
describes. A reviewer should be sceptical of the 900m figure specifically: it is derived
from the fog model, and the fog model's own tuning has never been checked against hardware.
