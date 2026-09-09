# Moving the world origin to Gärdet, and removing the scripted opening ride

Two changes, requested together and inseparable in effect: `START_LOCATION` moves from
Nathorstvägen in Hammarbyhöjden to the eastern edge of Gärdet in Östermalm, and the game no
longer opens on a scripted bus ride through the city. The player now starts parked in the
car at the new location, in control from the first frame.

## Why together

The old start was chosen so the opening ride's cross-town route to Ryssbergen would
actually resolve (`buildRoadGraph`/`findRoute` had to return a real path, not just a
straight-line guess). With the ride gone, that constraint is gone with it — there is
nothing left tying the spawn point to the story's destination, so the two decisions were
made at once rather than as a location change now and an unrelated ride removal later.

## The new point

Verified against live OSM data (`tiles.openfreemap.org`) with this repo's own decoder,
normalizer and predicates — the same rigor the previous point's docstring documented, run
fresh rather than assumed to transfer:

- not inside any water polygon or building footprint (`randomSpawn.ts`'s
  `isSafeSpawnPoint`);
- 25m from a bus-drivable `secondary`-tagged carriageway (`isBusDrivableKind`), excluding
  service roads, `*_construction` ways and tunnels;
- no tunnel segment within 5m.

`START_LOCATION_NAME` is `'Gärdet'`, not a street name: `WorldRoad` carries no `name`
field, so the nearby carriageway's actual OSM name was never checked, only its kind and
distance. Gärdet — the district — is the claim the verification above actually supports.

## What removing the opening ride touched

The opening ride was more than a route: it also drove a 15-second scripted camera
establishing shot (`resolveOpeningIntroPlacement` in `cameraRig.ts`, eased from the
top-down placement into the cinematic one) and suppressed player input while that shot
played. Both were built exclusively for this ride — nothing else called them — so both
came out with it, along with the runtime's `beginOpeningRide`/`openingRideController`
wiring and their four dedicated tests. This is the least reversible part of the change and
was not literally asked for on its own terms; if a scripted arrival shot is wanted back
without the auto-triggered ride underneath it, that is new work, not a revert.

What survives unchanged: `applyStartBusRide`/`applyStopBusRide` and the whole bus lifecycle
are a general mechanic, not specific to the opening ride — the manual "hail a bus"
overlay (`BusOverMap.tsx` → `App.tsx`'s `startBusRide`) uses the same path and is
unaffected. The debug seam `debugBoardBusRef` (`?dev=1`-gated) also survives; only its
comment, which referenced the now-gone opening ride, was reworded.

`scripts/prefetch-world.mjs` built one of its tile regions from `OPENING_RIDE`'s
from/to as a padded corridor. That region is gone rather than left pointing at deleted
config; a player-planned ride still fetches its own corridor live, the same as any route
other than the opening one always did.

## Story content this did not regress

Two beats in `src/story/projects/svartaksi-opening.json` reference the opening ride —
`opening-ride` (triggers on `route-progress` for a routeId nothing ever set) and
`meet-bonfire-pill` (requires flag `opening:left-bus`, which nothing ever sets either).
Both were already unreachable before this change: `routeProgress` was never populated by
any caller in the codebase, and no code path set `opening:left-bus`. This change did not
break a working beat — it removed the only place that could plausibly have populated
`routeProgress` for the specific `'opening-ride'` id, which had never been wired up to do
so. Making these beats reachable, if wanted, is separate work.

## What did not move: the bonfire camp

`bonfireCamp.ts`'s `CAMP_LOCATION` (Ryssbergen, Nacka) is a fixed, independent lng/lat —
it does not move when `START_LOCATION` does. It was originally placed ~970m from the old
Hammarbyhöjden start, inside that start's building-draw radius, specifically so the camp
had trees rendered around it from the first frame. It is now about 3.8km from the Gärdet
start by straight line: a real drive rather than a short walk. World data streams around
wherever the player actually is (not fixed around `START_LOCATION`), so the camp still
draws in correctly on approach — nothing there depends on proximity to the start. The
`near-place` trigger radius (6m) and the camp's own geometry are unaffected either way,
being independent of both locations.

## Offline snapshot

`vendor/worldcache/tiles` is committed so `deploy`'s `--offline --emit world` step (and a
player's first load) never needs the network. The existing tile set, built for the full
`TELEPORT_LOCATIONS` list, already covered a wide enough swath of central Stockholm that
Gärdet needed exactly one additional z14 tile (`14/9015/4815.pbf`) — fetched live and
committed alongside the updated `tiles/manifest.json`. Re-ran `prefetch-world.mjs
--offline --emit world` afterward to confirm the precomputed area regenerates with zero
live fetches, which is the actual invariant the deploy pipeline depends on.
`vendor/worldcache/areas/` itself stays gitignored, as before — it is build-time output,
not a committed asset.
