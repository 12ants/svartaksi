/**
 * Where the world begins and the teleport presets.
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
   * The eastern edge of Gärdet, the open field in Östermalm — chosen so the player
   * starts parked beside a real paved carriageway rather than out on the field itself.
   * Named `Gärdet` rather than a specific street below: `WorldRoad` carries no `name`
   * field (only `kind`), so the nearby carriageway's OSM road name was never checked,
   * only its kind and distance — Gärdet is the claim that check actually supports.
   *
   * Verified against live OSM data (tiles.openfreemap.org), using this repo's own
   * decoder, normalizer and predicates rather than asserted:
   *
   * - not inside any water polygon and not inside any building footprint (the two halves
   *   of `randomSpawn.ts`'s `isSafeSpawnPoint`);
   * - 25m from a bus-drivable street (`isBusDrivableKind`, the same predicate
   *   `busRouting.ts` filters on, resolving to a `secondary`-tagged carriageway) — far
   *   enough not to stand in the carriageway, close enough to walk to. Service roads,
   *   `*_construction` ways and tunnel segments are excluded: a driveway is not a
   *   street, and a tunnel has no surface to stand on;
   * - no tunnel segment within 5m of the point.
   *
   * The game no longer opens on a scripted bus ride (see the removed OPENING_RIDE, and
   * `applyStartBusRide` for the general boarding mechanic that survives it), so there is
   * no route-length check to run here the way the previous Hammarbyhöjden pick had one
   * against its Ryssbergen destination — the player starts parked in the car.
   *
   * One consequence worth flagging rather than silently working around: the story's
   * bonfire camp (`bonfireCamp.ts`'s CAMP_LOCATION, Ryssbergen in Nacka) is a fixed,
   * independent lng/lat that does not move with START_LOCATION. It is now about 3.8km
   * from here by straight line — a real drive rather than the ~970m walk it was placed
   * for, and the offline snapshot in `vendor/worldcache` still covers only the old
   * Hammarbyhöjden area, so both this point and the drive to the camp need a live
   * connection until `pnpm prefetch:world` is re-run for the new area.
   */
  lng: 18.11314,
  lat: 59.34281,
} as const;

export const START_LOCATION_NAME = 'Gärdet';

/**
 * Query parameter that turns the opening cinematic off: `?intro=0`.
 *
 * The intro is a fixed thirty-odd seconds before control, which is the right shape for a
 * player opening the game once and the wrong shape for a developer reloading it two
 * hundred times an afternoon. Rather than a build flag nobody remembers to flip, it is a
 * URL the dev server can be bookmarked at.
 */
export const INTRO_QUERY_PARAMETER = 'intro';

/**
 * Whether to play the opening cinematic for this session.
 *
 * Anything but an explicit `0`/`off`/`false` plays it, so a malformed parameter shows the
 * player the intro rather than silently skipping the opening of the game.
 */
export function isIntroRequested(search: string): boolean {
  const value = new URLSearchParams(search).get(INTRO_QUERY_PARAMETER);
  if (value === null) return true;
  return !['0', 'off', 'false', 'no'].includes(value.toLowerCase());
}

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
  // Kept as a teleport preset in its own right after the scripted opening ride that used
  // to end here was removed — see CAMP_LOCATION in bonfireCamp.ts, ~110m further on.
  { label: 'Ryssbergen South', lng: 18.149222, lat: 59.313816 },
  { label: 'Sickla', lng: 18.1268, lat: 59.3062 },
  { label: 'Gamla Stan', lng: 18.0717, lat: 59.3257 },
  { label: 'Sergels Torg', lng: 18.0652, lat: 59.3326 },
  { label: 'Djurgården', lng: 18.1356, lat: 59.3266 },
] as const;
