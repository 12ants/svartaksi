import {
  DEFAULT_TERRAIN_SETTINGS,
  normalizeTerrainSettings,
  type TerrainSettings,
} from './terrain';

/** Which world surfaces to render and at what quality; persisted to localStorage between sessions. */
export type RenderQuality = 'performance' | 'balanced' | 'high';

export interface RenderOptions {
  quality: RenderQuality;
  ground: boolean;
  parks: boolean;
  water: boolean;
  roads: boolean;
  buildings: boolean;
  facades: boolean;
  streetFurniture: boolean;
  streetLights: boolean;
  facadeDetails: boolean;
  windowBrightness: number;
  windowOccupancy: number;
  windowWarmth: number;
  windowFrameWidth: number;
  windowCastLight: boolean;
  dynamicResolution: boolean;
  cinematicMaterials: boolean;
  highQualityShadows: boolean;
  /** Draws every collision frame, contact and suspension ray the physics world is
   * actually solving, over the top of the scene. See physics/debugRenderer.ts. */
  physicsWireframe: boolean;
  /**
   * The explicit debug/editor override for backlog item 9's surface-visibility split:
   * draws every road in range, including tunnels and fully-covered ground roads that
   * `surfaceVisibility` (`./surfaceVisibility.ts`) hides by default. Only ever exposed
   * from the developer panel, itself gated behind `?dev=1` (see devMode.ts) — a normal
   * player never reaches this flag, and it never affects which roads exist in `WorldData`
   * or are routable, only which ones get a drawn surface.
   */
  debugShowHiddenRoads: boolean;
  /** How tall the mapped landuse stands and how its edges slope — the ground both the
   * renderer and the physics world read. See terrain.ts. */
  terrain: TerrainSettings;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  quality: 'balanced', ground: true, parks: true, water: true,
  roads: true, buildings: true, facades: true, streetFurniture: true,
  streetLights: true, facadeDetails: true, dynamicResolution: true,
  cinematicMaterials: true, highQualityShadows: true, physicsWireframe: false,
  debugShowHiddenRoads: false,
  windowBrightness: 1, windowOccupancy: 1, windowWarmth: 0, windowFrameWidth: 1, windowCastLight: false,
  terrain: { ...DEFAULT_TERRAIN_SETTINGS },
};

export const RENDER_OPTIONS_STORAGE_KEY = 'svartaksi:render-options';
const QUALITIES: readonly RenderQuality[] = ['performance', 'balanced', 'high'];
const SURFACES = ['ground', 'parks', 'water', 'roads', 'buildings', 'facades', 'streetFurniture'] as const;
const QUALITY_FLAGS = [
  'windowCastLight',
  'physicsWireframe',
  'cinematicMaterials',
  'highQualityShadows',
  'streetLights',
  'facadeDetails',
  'dynamicResolution',
  'debugShowHiddenRoads',
] as const;

export function normalizeRenderOptions(raw: unknown): RenderOptions {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_RENDER_OPTIONS };
  const input = raw as Record<string, unknown>;
  const options = { ...DEFAULT_RENDER_OPTIONS };
  if (typeof input.quality === 'string' && (QUALITIES as readonly string[]).includes(input.quality)) {
    options.quality = input.quality as RenderQuality;
  }
  for (const surface of SURFACES) {
    if (typeof input[surface] === 'boolean') options[surface] = input[surface];
  }
  for (const flag of QUALITY_FLAGS) {
    if (typeof input[flag] === 'boolean') options[flag] = input[flag];
  }
  for (const [key, min, max] of WINDOW_CONTROL_RANGES) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) options[key] = Math.min(max, Math.max(min, value));
  }
  options.terrain = normalizeTerrainSettings(input.terrain);
  return options;
}

export function loadRenderOptions(storage: Pick<Storage, 'getItem'>): RenderOptions {
  try {
    const stored = storage.getItem(RENDER_OPTIONS_STORAGE_KEY);
    return stored ? normalizeRenderOptions(JSON.parse(stored)) : { ...DEFAULT_RENDER_OPTIONS };
  } catch {
    return { ...DEFAULT_RENDER_OPTIONS };
  }
}

export function saveRenderOptions(storage: Pick<Storage, 'setItem'>, options: RenderOptions): void {
  try {
    storage.setItem(RENDER_OPTIONS_STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Persistence is best-effort.
  }
}

export const RENDER_QUALITY = {
  performance: { pixelRatio: 1, shadows: false, facadeInstances: 1_400, buildingDistance: 350, streetLightInstances: 140, treeInstances: 1_000 },
  balanced: { pixelRatio: 1.5, shadows: true, facadeInstances: 5_000, buildingDistance: 500, streetLightInstances: 280, treeInstances: 3_500 },
  high: { pixelRatio: 2, shadows: true, facadeInstances: 10_000, buildingDistance: 650, streetLightInstances: 450, treeInstances: 6_000 },
} as const;

export interface EffectiveRenderQuality {
  pixelRatioCap: number;
  shadows: boolean;
  shadowTier: RenderQuality;
  facadeInstances: number;
  buildingDistance: number;
  streetLightInstances: number;
  /** Trees scattered through the world's landuse polygons — see vegetation.ts. Four
   * instanced draw calls regardless of count, so this bounds geometry and shadow-map
   * cost rather than draw calls. */
  treeInstances: number;
  secondaryDetails: boolean;
  cinematicMaterials: boolean;
}

export function resolveEffectiveRenderQuality(
  options: RenderOptions,
  budgetScale: number,
): EffectiveRenderQuality {
  const tier = RENDER_QUALITY[options.quality];
  const scale = Math.min(1, Math.max(0.35, budgetScale));
  const performance = options.quality === 'performance';
  return {
    pixelRatioCap: tier.pixelRatio * (options.dynamicResolution ? scale : 1),
    shadows: tier.shadows,
    shadowTier: options.highQualityShadows ? options.quality : 'performance',
    facadeInstances: Math.max(1, Math.round(tier.facadeInstances * scale)),
    buildingDistance: Math.max(1, Math.round(tier.buildingDistance * scale)),
    streetLightInstances: options.streetLights
      ? Math.max(1, Math.round(tier.streetLightInstances * scale))
      : 0,
    treeInstances: Math.max(0, Math.round(tier.treeInstances * scale)),
    secondaryDetails: options.facadeDetails && !performance && scale >= 0.6,
    cinematicMaterials: options.cinematicMaterials && !performance,
  };
}

/**
 * How opaque the fog is at the building draw distance, expressed as the `density *
 * distance` product FogExp2 actually reads: `1 - exp(-(d * x)^2)`, so 1.9 is about 97%.
 *
 * Buildings are hard-cut at their draw distance, and the only thing hiding that cut is
 * fog having already swallowed them. Tying the two together with one number means the
 * cut stays hidden wherever the distance ends up, rather than the fog being tuned for
 * one tier and leaking at the others.
 */
const FOG_OPACITY_AT_DRAW_DISTANCE = 1.9;
/** Floor and ceiling on the resulting density. The floor keeps a long-sighted tier from
 * losing the haze that gives the city its depth; the ceiling stops a machine that has
 * fallen all the way to the minimum budget from being fogged in at arm's length. */
const MIN_FOG_DENSITY = 0.0016;
const MAX_FOG_DENSITY = 0.0042;

/**
 * FogExp2 density that reaches the same opacity at whatever draw distance the tier and
 * the frame-time budget have settled on.
 *
 * The practical effect is that a machine which starts struggling gets *more* fog: the
 * render budget pulls the building distance in, and the fog thickens to meet it, so the
 * work saved by drawing fewer buildings does not show up as buildings blinking out of a
 * clear sky. Slower machines see a hazier city, which is a far better trade than a
 * visibly shorter one.
 */
export function fogDensityFor(buildingDistance: number): number {
  if (!(buildingDistance > 0)) return MAX_FOG_DENSITY;
  const density = FOG_OPACITY_AT_DRAW_DISTANCE / buildingDistance;
  return Math.min(MAX_FOG_DENSITY, Math.max(MIN_FOG_DENSITY, density));
}

/**
 * `radius` is in shadow-map texels: under PCFShadowMap (see SHADOW_CONFIG in
 * svartaksiRuntime) it scales a 5-tap Vogel disk whose rotation is dithered per pixel, so
 * it buys penumbra width without the banding a fixed-kernel blur produces. Kept at a
 * roughly constant *world* penumbra across tiers. Texel size is `extent * 2 / mapSize`,
 * which is not monotonic in tier — `high` widens the frustum over the same 4096 map
 * that `balanced` uses, so its texels are the *coarser* of the two — and the radii
 * follow from that rather than from the tier order. All three land near a 31cm soft
 * edge, so changing quality doesn't visibly change how soft shadows look.
 */
const SHADOW_QUALITY = {
  performance: { mapSize: 2048, radius: 3, normalBias: 0.05, extent: 105 },
  balanced: { mapSize: 4096, radius: 5, normalBias: 0.04, extent: 130 },
  high: { mapSize: 4096, radius: 4.5, normalBias: 0.032, extent: 150 },
} as const;

/**
 * Resolves the shadow settings for a quality tier. `highQualityShadows` is the HUD's
 * own opt-out: turning it off drops to the `performance` settings (smaller map, tighter
 * frustum, less blur) at any tier, which is the cheapest meaningful lever a player has
 * over frame cost short of changing tier outright.
 */
export function shadowQualityFor(quality: RenderQuality, highQualityShadows = true) {
  return SHADOW_QUALITY[highQualityShadows ? quality : 'performance'];
}

export const WINDOW_CONTROL_RANGES = [
  ['windowBrightness', 0, 3], ['windowOccupancy', 0, 2],
  ['windowWarmth', -1, 1], ['windowFrameWidth', 0.25, 2],
] as const;

/** Appearance-only edits must not rebuild geometry, collision indexes or shadow maps. */
export function onlyWindowOptionsChanged(previous: RenderOptions, next: RenderOptions): boolean {
  return (Object.keys(previous) as (keyof RenderOptions)[]).every(key =>
    key.startsWith('window') || (key === 'terrain'
      ? JSON.stringify(previous.terrain) === JSON.stringify(next.terrain)
      : previous[key] === next[key]));
}
