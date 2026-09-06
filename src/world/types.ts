/** Shared world model: the common shape every data provider normalizes into, and threeWorld renders from. */
export type WorldSource = 'maplibre';
export type { WorldInspectionRecord } from './inspection';

export interface LngLat {
  lng: number;
  lat: number;
}

export interface LocalPoint {
  x: number;
  z: number;
}

export interface ChunkKey {
  z: number;
  x: number;
  y: number;
}

/**
 * Normalized vertical placement of a road segment, derived from OSM `structure`/
 * `brunnel`/`bridge`/`tunnel` tags at the provider boundary (see
 * `roadElevationProfile.ts`'s `normalizeRoadStructure`) rather than read ad hoc by each
 * consumer. `'ford'` is grouped with `'ground'` for elevation purposes — both cross at
 * grade — but kept distinct because it is real source evidence, not a guess.
 */
export type RoadStructure = 'ground' | 'bridge' | 'tunnel' | 'ford';

export interface WorldRoad {
  id: string;
  kind: string;
  width: number;
  points: LocalPoint[];
  /** Normalized bridge/tunnel/ford/ground state. Defaults to 'ground' when absent —
   * older fixtures and the preview grid don't set this. */
  structure?: RoadStructure;
  /** OSM `layer`: ordering evidence only, not meters. Defaults to 0. */
  layer?: number;
}

export interface WorldBuilding {
  id: string;
  height: number;
  rings: LocalPoint[][];
  properties: Record<string, unknown>;
  appearance?: WorldBuildingAppearance;
  entrances?: WorldEntrance[];
}

export interface WorldBuildingAppearance {
  buildingKind?: string;
  buildingUse?: string;
  material?: string;
  wallColor?: string;
  roofShape?: string;
  roofMaterial?: string;
  roofColor?: string;
  levels?: number;
  houseNumber?: string;
}

export interface WorldEntrance {
  point: LocalPoint;
  tags: Record<string, unknown>;
}

export interface WorldArea {
  id: string;
  kind: string;
  rings: LocalPoint[][];
}

export interface WorldLabel {
  id: string;
  text: string;
  point: LocalPoint;
  category?: string;
  detail?: string;
}

export interface WorldObject {
  id: string;
  kind: string;
  point: LocalPoint;
  properties: Record<string, unknown>;
}

export interface WorldData {
  source: WorldSource;
  roads: WorldRoad[];
  buildings: WorldBuilding[];
  water: WorldArea[];
  parks: WorldArea[];
  labels: WorldLabel[];
  objects: WorldObject[];
}

/**
 * Separate poll radii per data category: roads and terrain (parks/water) are cheap to
 * render per unit area and matter over a much longer visible/driving distance than
 * buildings, whose dense per-instance geometry is the expensive part — so buildings stay
 * clipped close to the camera while roads/terrain are fetched from a much wider area.
 */
export interface WorldDataRadius {
  buildings: number;
  terrain: number;
}

/**
 * Asks a provider to cover a *route* rather than a disc: everything within `padMeters`
 * of the straight line from `from` to `to`.
 *
 * A long bus route needs road data along its whole length, and covering that with a
 * radius around its midpoint fetches an order of magnitude more area than the route
 * crosses — then, once a provider's own fetch cap trims that area, drops exactly the
 * two ends the route has to start and finish on.
 */
export interface WorldDataCorridor {
  from: LngLat;
  to: LngLat;
  padMeters: number;
}

export interface WorldDataProvider {
  readonly source: WorldSource;
  load(
    center: LngLat,
    radius: WorldDataRadius,
    signal: AbortSignal,
    origin?: LngLat,
    corridor?: WorldDataCorridor,
    // Defaults to 'background' when a corridor is given and 'foreground' otherwise — the
    // usual case (route-finding vs. the world on screen). A caller streaming a *rendered*
    // corridor (the bus's own route, a leg ahead) is foreground work despite the shape,
    // and passes this explicitly rather than being starved behind background traffic.
    priority?: 'foreground' | 'background',
  ): Promise<WorldData>;
}
