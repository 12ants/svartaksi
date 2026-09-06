/**
 * Where the world begins, what the opening ride is, and the teleport presets.
 *
 * START_LOCATION is not just a spawn point: it is the *origin* of the local meter
 * coordinate system every other module works in (see `world/geo.ts`). Moving it moves
 * the whole world's frame of reference, so anything that stores a LocalPoint across a
 * change of this value is storing a point that no longer means what it did. Nothing
 * currently does — routes, spawns and the stream anchor are all derived per session —
 * but that is the invariant to preserve if you add persistence.
 */
export const START_LOCATION = {
  /**
   * A roadside spot on Nathorstvägen in Hammarbyhöjden, chosen at random rather than
   * picked by hand: `--seed=20260905` into a uniform draw over the shipped tile cache,
   * taking the first point that survived every check below. Recorded so the choice can be
   * reproduced or re-rolled.
   *
   * Every condition was verified against the shipped tiles in `vendor/worldcache`, using
   * this repo's own decoder, normalizer and predicates rather than asserted:
   *
   * - not inside any water polygon and not inside any building footprint (the two halves
   *   of `randomSpawn.ts`'s `isSafeSpawnPoint`);
   * - 19m from a bus-drivable street (`isBusDrivableKind`, the same predicate
   *   `busRouting.ts` filters on) — far enough not to stand in the carriageway, close
   *   enough to walk to. Service roads, `*_construction` ways and tunnel segments are
   *   excluded: a driveway is not a street, and a tunnel has no surface to stand on (an
   *   earlier candidate sat 30m from Hammarbytunneln, which is underground there);
   * - the opening ride actually routes. `buildRoadGraph`/`findRoute` return a 5.5km bus
   *   route to OPENING_RIDE.to against a 3.8km straight line. That test is what rejected a
   *   candidate on Lidingö, which looked 3.6km away and is an island reachable only by
   *   bridge through central Stockholm.
   */
  lng: 18.090103,
  lat: 59.297155,
} as const;

export const START_LOCATION_NAME = 'Nathorstvägen';

/**
 * The ride the game opens on: north-east from the Nathorstvägen start to Ryssbergen,
 * ending about 110m from the bonfire camp. The destination is unchanged — only the
 * departure moved, so the story arrives where it always did.
 *
 * The route itself is not stored here. It is resolved at startup from live road data
 * (see `busCorridor.ts`), because a hard-coded polyline would drift out of agreement
 * with the world actually rendered around it the first time the source data changed.
 * These two points and the label are the whole of the fixed part.
 */
export const OPENING_RIDE = {
  from: START_LOCATION,
  to: { lng: 18.149222, lat: 59.313816 },
  destinationName: 'Ryssbergen South',
} as const;

/**
 * How far each world-data category is polled from, per WorldDataProvider.load. Roads and
 * terrain (parks/water) fetch from a much wider area than buildings — they read fine from
 * a distance and matter over a longer driving/visible range, while buildings are the
 * expensive part (one instanced facade per wall) and stay capped close to the camera.
 */
export const WORLD_DATA_RADIUS = {
  buildings: 560,
  terrain: 1_500,
} as const;

export const TELEPORT_LOCATIONS = [
  { label: START_LOCATION_NAME, lng: START_LOCATION.lng, lat: START_LOCATION.lat },
  { label: OPENING_RIDE.destinationName, lng: OPENING_RIDE.to.lng, lat: OPENING_RIDE.to.lat },
  { label: 'Sickla', lng: 18.1268, lat: 59.3062 },
  { label: 'Gamla Stan', lng: 18.0717, lat: 59.3257 },
  { label: 'Sergels Torg', lng: 18.0652, lat: 59.3326 },
  { label: 'Djurgården', lng: 18.1356, lat: 59.3266 },
] as const;
