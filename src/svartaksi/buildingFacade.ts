/**
 * Facade "profile" resolution: given a building/area context, pick a deterministic
 * wall/window/door look (colors, window grid spacing) and cache the resulting
 * THREE.Material so identical profiles share one material instance.
 */
import * as THREE from 'three';

import { DEPTH_BIAS, withLogDepthBias } from '../world/depthBias';

import {
  resolveFacadeColors,
  stableFacadeVariant,
  type FacadeAreaKind,
  type FacadeColorScheme,
  type FacadeFamily,
  type FacadeVariant,
} from './facadePalette';
import { DEFAULT_DOOR_BOTTOM, DEFAULT_DOOR_HEIGHT } from './doorPlacement';
import { createSceneLightingUniforms, SCENE_LIGHTING_PARS_GLSL } from '../world/shaderLighting';
export type { FacadeFamily } from './facadePalette';

/** Shortest a ground floor may ever be: tall enough that no window row (which always
 * starts at or above `firstFloorHeight`) can vertically reach down into a door's
 * rectangle, no matter which wall column the door sits in. A fixed 0.3m lintel gap
 * on top keeps the cut from reading as flush/accidental. */
export const MIN_GROUND_FLOOR_HEIGHT = DEFAULT_DOOR_BOTTOM + DEFAULT_DOOR_HEIGHT + 0.3;

export interface FacadeProfile {
  firstFloorHeight: number; // Height in meters where windows start
  roofPadding: number;       // Clear space kept below the roof line
  sidePadding: number;       // Side padding margin in meters
  windowWidth: number;       // Width of each window
  windowHeight: number;      // Height of each window
  windowSpacingX: number;    // Horizontal spacing (width + gap)
  windowSpacingY: number;    // Vertical spacing (floor height)
  wallColor: string;         // Hex color of the wall
  windowColor: string;       // Hex color of lit windows
  doorColor: string;         // Hex color of doors
  litRatio: number;          // Percent of lit windows (0.0 to 1.0)
  windowGlow?: number;       // Emissive glow multiplier for lit windows (default 0.8)
  signColor?: string;        // Awning/signage accent color (stores only)
}

export interface FacadeContext {
  identity: string;
  areaId: string;
  areaKind: FacadeAreaKind;
  colorScheme: FacadeColorScheme;
}

export interface ResolvedFacadeProfile {
  family: FacadeFamily;
  variant: FacadeVariant;
  profileKey: string;
  profile: FacadeProfile;
}

function readBuildingHeight(properties: Record<string, unknown>): number {
  const parsed = Number(properties.height);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 44;
}

/** Deterministic 0..1 hash, independent of the family/variant/palette hashes elsewhere. */
function stableUnit(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

/** Fraction of otherwise-generic low/mid-rise buildings that spawn as ground-floor shops. */
const STORE_SPAWN_CHANCE = 0.1;
const STORE_SPAWN_MAX_HEIGHT = 22;

/** Quantize noisy source properties into the small material/batch vocabulary. `identity`
 * (a stable per-building id) unlocks probabilistic store spawning for otherwise generic
 * buildings — callers that omit it (unit tests, ad-hoc lookups) get purely tag-driven,
 * deterministic-without-randomness classification. */
export function getFacadeFamily(
  properties: Record<string, unknown> | null | undefined,
  identity?: string,
): FacadeFamily {
  const props = properties ?? {};
  const type = [
    props.type, props.class, props['building:use'], props.building,
    props.office, props.shop, props.amenity, props.tourism,
  ].filter(Boolean).join(' ').toLowerCase();
  const height = readBuildingHeight(props);
  if (/office|government|civic|hospital|university/.test(type) || height > 50) return 'office';
  if (/shop|store|boutique|kiosk|bakery|grocery|supermarket|convenience|market/.test(type)) return 'store';
  if (/commercial|retail|hotel|museum|restaurant/.test(type)) return 'commercial';
  if (/industrial|warehouse|factory|hangar|storage/.test(type)) return 'industrial';
  // A bare `building=yes`/untagged footprint carries no real information — the same
  // generic case Mapbox Standard fills in with occasional storefronts to break up
  // otherwise uniform residential blocks, rather than every ground floor being blank.
  const generic = type.trim().length === 0 || type.trim() === 'yes';
  if (identity && generic && height <= STORE_SPAWN_MAX_HEIGHT && stableUnit(`${identity}:store-roll`) < STORE_SPAWN_CHANCE) {
    return 'store';
  }
  return 'residential';
}

export function getFacadeProfile(properties: Record<string, unknown> | null | undefined): FacadeProfile {
  return buildProfileForFamily(getFacadeFamily(properties ?? {}));
}

/**
 * Builds the profile for an already-resolved family. Split out from getFacadeProfile
 * so resolveFacadeProfile can classify once (with its identity-aware, possibly
 * randomized `store` roll) and build from that exact result — calling
 * getFacadeFamily a second time here without the identity would silently disagree
 * with the first call on whether a building is a store.
 */
function buildProfileForFamily(family: FacadeFamily): FacadeProfile {
  // Default fallbacks (residential style)
  const profile: FacadeProfile = {
    firstFloorHeight: 4.0, 
    roofPadding: 0.8,
    sidePadding: 1.2,
    windowWidth: 0.9,
    windowHeight: 1.5,
    windowSpacingX: 1.8,
    windowSpacingY: 3.0,
    wallColor: '#2b2e3a',
    windowColor: '#ffeaad',
    doorColor: '#9A603F',
    litRatio: 0.6,
  };

  // Adjust parameters based on metadata
  if (family === 'office') {
    profile.firstFloorHeight = 5.0; // Taller entrance lobbies
    profile.roofPadding = 1.0;
    profile.sidePadding = 1.5;
    profile.windowWidth = 1.1;
    profile.windowHeight = 1.8;
    profile.windowSpacingX = 2.0;
    profile.windowSpacingY = 3.3;
    profile.wallColor = '#1f2530'; // Sleeker dark metal/glass look
    profile.windowColor = '#e0f2fe'; // Cool fluorescent blue-white
    profile.litRatio = 0.8;
  } else if (family === 'commercial') {
    profile.firstFloorHeight = 5.5; // High storefronts
    profile.roofPadding = 0.9;
    profile.sidePadding = 1.8;
    profile.windowWidth = 1.4;
    profile.windowHeight = 2.0;
    profile.windowSpacingX = 2.5;
    profile.windowSpacingY = 3.8;
    profile.wallColor = '#3f3939';
    profile.windowColor = '#ffe099';
    profile.litRatio = 0.7;
  } else if (family === 'industrial') {
    profile.firstFloorHeight = 6.0; // Big warehouses
    profile.roofPadding = 1.2;
    profile.sidePadding = 3.0;
    profile.windowWidth = 1.5;
    profile.windowHeight = 1.0;
    profile.windowSpacingX = 4.0;
    profile.windowSpacingY = 4.5;
    profile.wallColor = '#4a3f35'; // Brick/concrete brown
    profile.windowColor = '#ffd384';
    profile.litRatio = 0.2;
  } else if (family === 'store') {
    profile.firstFloorHeight = MIN_GROUND_FLOOR_HEIGHT; // Tall glazed shopfront, clear of the door
    profile.roofPadding = 0.7;
    profile.sidePadding = 0.9;
    // Wide, tall shopfront glass instead of punched windows — sized to read as a
    // storefront window from the street, with the neon sign (see neonSigns.ts) hung
    // clear above this row rather than overlapping it.
    profile.windowWidth = 2.6;
    profile.windowHeight = 2.8;
    profile.windowSpacingX = 3.0;
    profile.windowSpacingY = 3.6;
    profile.wallColor = '#8a3b2e'; // Warm brick/terracotta storefront
    profile.windowColor = '#fff3d6'; // Bright, inviting shopfront glow
    profile.doorColor = '#2a2118';
    profile.litRatio = 0.95; // Shops read as lit/open almost always
    profile.windowGlow = 1.4; // Extra lighting: brighter than the other families
    profile.signColor = '#c1442e';
  }

  return profile;
}

export function resolveFacadeProfile(
  properties: Record<string, unknown> | null | undefined,
  context: FacadeContext,
): ResolvedFacadeProfile {
  const family = getFacadeFamily(properties, context.identity);
  const variant = stableFacadeVariant(context.identity, context.areaId, context.colorScheme);
  const scale = ([0.96, 1, 1.04] as const)[variant];
  const colors = resolveFacadeColors(context.colorScheme, family, variant, context.areaKind);
  const base = buildProfileForFamily(family);
  const mappedWallColor = resolveMappedWallColor(properties);
  const height = readBuildingHeight(properties ?? {});
  return {
    family,
    variant,
    profileKey: `${family}:${context.colorScheme}`,
    profile: {
      ...base,
      windowWidth: base.windowWidth * scale,
      windowHeight: base.windowHeight * scale,
      windowSpacingX: base.windowSpacingX * scale,
      windowSpacingY: base.windowSpacingY * scale,
      wallColor: mappedWallColor ?? jitterWallColor(colors.wallColor, context.identity, height),
      windowColor: colors.windowColor,
      doorColor: colors.doorColor,
    },
  };
}

/**
 * Layers a small continuous hue/lightness/saturation drift onto the family's palette
 * color, seeded by building id (so it's stable across rebuilds) and biased by height
 * (taller buildings trend a touch cooler/greyer, like glass-and-steel towers; short
 * ones trend warmer). This sits on top of the palette's existing 3 discrete variants
 * to break up the "every building on this variant looks identical" repetition —
 * every building gets its own shade, not just one of three.
 */
function jitterWallColor(hex: string, identity: string, height: number): string {
  const color = new THREE.Color(hex);
  const hueJitter = (stableUnit(`${identity}:hue`) - 0.5) * 0.05;
  const lightnessJitter = (stableUnit(`${identity}:lightness`) - 0.5) * 0.08;
  const heightFactor = Math.min(1, Math.max(0, (height - 20) / 100));
  color.offsetHSL(hueJitter - heightFactor * 0.02, -heightFactor * 0.06, lightnessJitter);
  return `#${color.getHexString().toUpperCase()}`;
}

const NAMED_BUILDING_COLORS: Record<string, string> = {
  beige: '#C8B99A', brick: '#9A5B45', brown: '#795548', cream: '#E8D7B5',
  grey: '#808080', gray: '#808080', red: '#A65345', white: '#D9D7CF', yellow: '#D4B65A',
};

function resolveMappedWallColor(properties: Record<string, unknown> | null | undefined): string | null {
  const raw = String(properties?.['building:colour'] ?? properties?.['building:color'] ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toUpperCase()}`;
  return NAMED_BUILDING_COLORS[raw] ?? null;
}

/**
 * A small, tileable pre-baked noise texture shared by every facade material —
 * replaces a per-pixel `sin(dot(...))*43758.5453` pseudo-random trick (used to pick
 * which window cells are lit) with a single texture fetch. Facade fragments are the
 * single largest per-pixel cost in this renderer (every visible wall pixel in the
 * city evaluates this), so trading the sin/fract/dot math for one cheap, cache-resident
 * texture lookup is a meaningful win. Baked once (deterministically, not Math.random,
 * so it doesn't change between reloads) and reused across every profile/material.
 */
const NOISE_TEXTURE_SIZE = 64;
let sharedNoiseTexture: THREE.DataTexture | null = null;

function getSharedNoiseTexture(): THREE.DataTexture {
  if (sharedNoiseTexture) return sharedNoiseTexture;
  const size = NOISE_TEXTURE_SIZE;
  const data = new Uint8Array(size * size);
  // A tiny deterministic LCG — not cryptographic, just needs to look random enough
  // for a window-lit dither pattern, and to stay identical across page reloads.
  let state = 0x9e3779b9;
  for (let index = 0; index < data.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[index] = state & 0xff;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  sharedNoiseTexture = texture;
  return texture;
}

/** Sample the same nearest-filtered noise texel as the facade shader. */
export function facadeWindowNoise(column: number, row: number, seed: number): number {
  const data = getSharedNoiseTexture().image.data as Uint8Array;
  const gpuSeed = Math.fround(seed);
  const x = Math.floor(Math.fround(column + gpuSeed)) % NOISE_TEXTURE_SIZE;
  const y = Math.floor(Math.fround(row + Math.fround(gpuSeed * 1.37))) % NOISE_TEXTURE_SIZE;
  return data[y * NOISE_TEXTURE_SIZE + x] / 255;
}

export const FACADE_VERTEX_SHADER = `
  attribute vec2 aWallSize;
  attribute vec2 aGridOrigin;
  attribute vec2 aGridCount;
  attribute vec4 aWindowMetrics;
  attribute vec4 aFacadeParams;
  attribute vec3 aFacadeColor;
  attribute vec4 aDoorRect;
  attribute vec3 aDoorGlass;
  attribute vec4 aDoorStyle;
  varying vec2 vLocalPos;
  varying vec2 vGridOrigin;
  varying vec2 vGridCount;
  varying vec4 vWindowMetrics;
  varying vec4 vFacadeParams;
  varying vec3 vFacadeColor;
  varying vec4 vDoorRect;
  varying vec3 vDoorGlass;
  varying vec4 vDoorStyle;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;
  varying float vFogDepth;

  #include <common>
  #include <logdepthbuf_pars_vertex>
  #include <shadowmap_pars_vertex>

  void main() {
    vLocalPos = vec2(uv.x * aWallSize.x, uv.y * aWallSize.y);
    vGridOrigin = aGridOrigin;
    vGridCount = aGridCount;
    vWindowMetrics = aWindowMetrics;
    vFacadeParams = aFacadeParams;
    vFacadeColor = aFacadeColor;
    vDoorRect = aDoorRect;
    vDoorGlass = aDoorGlass;
    vDoorStyle = aDoorStyle;

    // The wall's true outward direction is the instance basis's third column (see
    // facadeRenderer's makeBasis) — taken directly rather than through
    // <defaultnormal_vertex>, because for one of the two footprint windings that basis
    // is mirrored (negative determinant) and the derived normal would point *into* the
    // building for every such wall. Reading the column keeps every facade in the city
    // agreeing on which way is out, which is the whole point of lighting them by the
    // real sun direction.
    vec3 outward = normalize(mat3(instanceMatrix)[2]);
    vWorldNormal = normalize(mat3(modelMatrix) * outward);
    vec3 transformed = vec3(position);
    vec3 transformedNormal = normalMatrix * outward;

    #include <project_vertex>
    // Camera-space position — the space Three uploads dynamic light positions in, see
    // dynamicLightsContribution in shaderLighting.ts.
    vViewPosition = mvPosition.xyz;
    vFogDepth = -mvPosition.z;
    #include <worldpos_vertex>
    #include <shadowmap_vertex>
    #include <logdepthbuf_vertex>
  }
`;

export const FACADE_FRAGMENT_SHADER = `
  uniform vec3 uWindowColor;
  uniform vec3 uDoorColor;
  uniform float uWindowGlow;
  uniform float uWindowBrightness;
  uniform float uWindowOccupancy;
  uniform float uWindowWarmth;
  uniform float uWindowFrameWidth;
  // A small pre-baked tileable noise texture — see getSharedNoiseTexture — sampled
  // instead of computing a per-pixel sin/fract pseudo-random value.
  uniform sampler2D uNoise;
  // Declared directly (not via the <fog_pars_fragment> chunk) — the chunk's
  // conditionally-declared uniforms were being dropped from this program's
  // active-uniform list, which crashes WebGLRenderer's per-frame fog refresh.
  uniform vec3 fogColor;
  uniform float fogDensity;

  varying vec2 vLocalPos;
  varying vec2 vGridOrigin;
  varying vec2 vGridCount;
  varying vec4 vWindowMetrics;
  varying vec4 vFacadeParams;
  varying vec3 vFacadeColor;
  varying vec4 vDoorRect;
  varying vec3 vDoorGlass;
  varying vec4 vDoorStyle;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;
  varying float vFogDepth;

  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>
  #include <logdepthbuf_pars_fragment>
${SCENE_LIGHTING_PARS_GLSL}

  /** 1 strictly inside [0, size], falling off over one pixel at each edge. "scale" is
   * the local-space size of a pixel, from the caller's own screen-space derivative —
   * every window/frame edge in this shader is a hard rectangle boundary repeating at
   * roughly a meter, which aliases into a shimmering mess at any distance without it. */
  float bandMask(float value, float size, float scale) {
    float aa = max(scale, 1e-5);
    return smoothstep(-aa, aa, min(value, size - value));
  }

  void main() {
    float localX = vLocalPos.x;
    float localY = vLocalPos.y;
    vec3 baseWallColor = vFacadeColor;
    vec3 albedo = baseWallColor;
    vec3 emissive = vec3(0.0);

    // How much of the facade's window population reads as lit: a handful during the
    // day (someone's light left on), nearly all of them at night. Without this the
    // whole city rendered as glowing window grids under a noon sky.
    float litScale = mix(0.06, 1.0, uNightFactor);
    float glowScale = mix(0.12, 1.0, uNightFactor) * uWindowBrightness;
    vec3 windowTint = mix(uWindowColor, uWindowWarmth < 0.0 ? vec3(0.55, 0.75, 1.0) : vec3(1.0, 0.58, 0.22), abs(uWindowWarmth));

    float doorHalfWidth = vDoorRect.z * 0.5;
    bool onDoor = vFacadeParams.y > 0.5 &&
      localX >= vDoorRect.x - doorHalfWidth &&
      localX <= vDoorRect.x + doorHalfWidth &&
      localY >= vDoorRect.y &&
      localY <= vDoorRect.y + vDoorRect.w;

    if (onDoor) {
      float styleShade = 0.82 + vDoorStyle.x * 0.045;
      albedo = uDoorColor * styleShade;

      float doorLocalX = (localX - (vDoorRect.x - doorHalfWidth)) / max(vDoorRect.z, 0.001);
      float panelLineDistance = abs(fract(doorLocalX * max(vDoorStyle.z, 1.0)) - 0.5);
      if (panelLineDistance > 0.5 - vDoorStyle.y) {
        albedo *= 0.55;
      }

      // A door's own glazed pane (see doorPlacement.ts's glassPaneForDoor) — sized and
      // vertically offset relative to the door rect, so it's always a sub-region of the
      // door itself and never spills onto the surrounding wall. aDoorGlass.x == 0 means
      // this door has no glass (a plain solid door).
      float glassHalfWidth = vDoorGlass.x * 0.5;
      if (
        vDoorGlass.x > 0.0 &&
        localX >= vDoorRect.x - glassHalfWidth &&
        localX <= vDoorRect.x + glassHalfWidth &&
        localY >= vDoorGlass.y &&
        localY <= vDoorGlass.y + vDoorGlass.z
      ) {
        // The pane reads as light spilling out through the doorway, over a faint tint
        // of the door's own frame color.
        albedo *= 0.3;
        emissive += windowTint * uWindowGlow * glowScale;
      }
    }

    // The CPU solver supplies a centered grid made only of complete modules.
    float rx = localX - vGridOrigin.x;
    float ry = localY - vGridOrigin.y;
    // Derivatives of the *unwrapped* wall coordinates — mod() below is discontinuous at
    // every cell boundary, so taking fwidth of the wrapped value would spike into a
    // full-cell-wide blur along each seam.
    float pixelX = fwidth(rx);
    float pixelY = fwidth(ry);
    if (!onDoor && rx >= 0.0 && ry >= 0.0) {
      float cellX = floor(rx / vWindowMetrics.z);
      float cellY = floor(ry / vWindowMetrics.w);
      if (cellX < vGridCount.x && cellY < vGridCount.y) {
        // A door doesn't just blank the pixels directly under it — it blanks the
        // whole window module in its column/row. Per-pixel-only masking (the old
        // behavior) let a door slice through the middle of a window cell, leaving a
        // jagged sliver of frame/glass hugging the doorway; small low-rise houses
        // (whose ground floor starts low enough for row 0 to reach door height) hit
        // this constantly. Dropping the entire overlapping cell instead reads as one
        // clean gap punched in the window row, like a real door — and because it's
        // cell-based rather than a taller mandatory floor band, short buildings still
        // keep their other ground-floor windows instead of losing the whole row.
        float cellLeft = vGridOrigin.x + cellX * vWindowMetrics.z;
        float cellBottom = vGridOrigin.y + cellY * vWindowMetrics.w;
        bool cellOverlapsDoor = vFacadeParams.y > 0.5 &&
          cellLeft < vDoorRect.x + doorHalfWidth &&
          cellLeft + vWindowMetrics.x > vDoorRect.x - doorHalfWidth &&
          cellBottom < vDoorRect.y + vDoorRect.w &&
          cellBottom + vWindowMetrics.y > vDoorRect.y;
        float insideCellX = mod(rx, vWindowMetrics.z);
        float insideCellY = mod(ry, vWindowMetrics.w);

        if (!cellOverlapsDoor) {
          float openingMask = bandMask(insideCellX, vWindowMetrics.x, pixelX)
            * bandMask(insideCellY, vWindowMetrics.y, pixelY);
          // Every window is a clean, undivided rectangle — just a frame, no mullion/
          // crossbar split panes (those variants were removed; vFacadeParams.w is kept
          // only for its subtle per-wall frame-width jitter below).
          float frameWidth = (0.055 + vFacadeParams.w * 0.012) * uWindowFrameWidth;
          float paneMask = openingMask
            * bandMask(insideCellX - frameWidth, vWindowMetrics.x - frameWidth * 2.0, pixelX)
            * bandMask(insideCellY - frameWidth, vWindowMetrics.y - frameWidth * 2.0, pixelY);
          float frameMask = openingMask - paneMask;
          // A shallow sill shadow immediately under each opening.
          float sillMask = (1.0 - openingMask)
            * bandMask(insideCellX, vWindowMetrics.x, pixelX)
            * bandMask(insideCellY - vWindowMetrics.y, 0.07, pixelY);

          // NearestFilter + one texel per integer cell step (dividing by the texture's own
          // size lands exactly on a texel) — RepeatWrapping handles tiling for cellX/cellY
          // values larger than the texture itself.
          float noiseVal = texture2D(uNoise, vec2(cellX + vFacadeParams.x, cellY + vFacadeParams.x * 1.37) / ${NOISE_TEXTURE_SIZE.toFixed(1)}).r;
          float lit = float(noiseVal < clamp(vFacadeParams.z * litScale * uWindowOccupancy, 0.0, 1.0));
          // Unlit glazing picks up a little of the sky it faces, so daytime windows
          // read as reflective glass rather than black holes punched in the wall.
          vec3 darkGlass = mix(
            mix(baseWallColor * 0.12, vec3(0.08, 0.12, 0.16), 0.55),
            uSkyColor * 0.5,
            0.35
          );
          vec3 paneColor = mix(darkGlass, windowTint, lit);

          albedo = mix(albedo, baseWallColor * 0.34, frameMask);
          albedo = mix(albedo, paneColor, paneMask);
          albedo = mix(albedo, baseWallColor * 0.58, sillMask);
          emissive += windowTint * uWindowGlow * glowScale * lit * paneMask;
        }
      }
    }

    // Contact shadow at the real, visible ground line. The shadow map's own normalBias
    // — needed so a wall's face doesn't acne against itself — pushes its sample point
    // away from exactly this corner, which is where a caster/receiver pair sits closest
    // together. Without something to counter it, the base of every wall in the city read
    // as a stray *bright* line: lighter than the wall above it, right where a building
    // should look most anchored to the ground. 4.0 is WALL_BASE_SINK (facadeRenderer.ts)
    // — local y=0 is that far below the real base, so the visible seam is at y==4.0.
    float groundContact = 1.0 - smoothstep(0.0, 0.6, vLocalPos.y - 4.0);
    albedo *= 1.0 - groundContact * 0.3;

    float shadowMask = getShadowMask();
    vec3 color = shadeSurface(albedo, vWorldNormal, shadowMask, vViewPosition) + emissive;
    gl_FragColor = vec4(color, 1.0);

    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);

    #include <logdepthbuf_fragment>
    #include <tonemapping_fragment>
    // THREE.Color stores values in linear space (ColorManagement); built-in
    // materials convert back to the renderer's sRGB output via this chunk, but
    // a custom ShaderMaterial has to opt in explicitly or everything renders
    // far too dark.
    #include <colorspace_fragment>
  }
`;

/**
 * How hard the direct sun drives a facade, relative to every other surface in the scene
 * (see the note on uSunResponse in shaderLighting).
 *
 * A building is the one thing in this world with large flat sides facing four different
 * directions at once, and that is what should say where the sun is: the south wall hot,
 * the north wall in its own shade, the two ends somewhere between. At a response of 1 the
 * hemisphere ambient term was close enough to the direct term that all four walls landed
 * within a few percent of each other, and a block read as a flat cut-out at every hour of
 * the day. Above 1 the sun-facing wall separates from the shaded one while the shaded one
 * still keeps its ambient — brighter where the light lands, not darker everywhere else.
 */
export const FACADE_SUN_RESPONSE = 1.85;

export function getOrCreateFacadeMaterial(
  profileKey: string,
  profile: FacadeProfile,
  materialsMap: Map<string, THREE.ShaderMaterial>
): THREE.ShaderMaterial {
  if (materialsMap.has(profileKey)) {
    return materialsMap.get(profileKey)!;
  }

  const windowColor = new THREE.Color(profile.windowColor);
  const doorColor = new THREE.Color(profile.doorColor);

  const material = new THREE.ShaderMaterial({
    vertexShader: withLogDepthBias(FACADE_VERTEX_SHADER, DEPTH_BIAS.facade),
    fragmentShader: FACADE_FRAGMENT_SHADER,
    // THREE.UniformsLib.fog supplies fogColor/fogDensity — for built-in material
    // types WebGLPrograms auto-merges that in, but for a plain ShaderMaterial the
    // renderer's per-frame uniform cache is just `material.uniforms` verbatim, so
    // without merging it in ourselves `material.fog = true` crashes the renderer
    // the first time it tries to refresh a fog uniform that was never declared here.
    // UniformsLib.lights is here for exactly the same reason, for `lights: true`:
    // it's what the <shadowmap_pars_*>/<shadowmask_pars_fragment> chunks below read
    // to receive the scene's directional shadow.
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, THREE.UniformsLib.lights, {
      ...createSceneLightingUniforms(),
      uWindowColor: { value: windowColor },
      uDoorColor: { value: doorColor },
      uWindowGlow: { value: profile.windowGlow ?? 0.8 },
      uWindowBrightness: { value: 1 },
      uWindowOccupancy: { value: 1 },
      uWindowWarmth: { value: 0 },
      uWindowFrameWidth: { value: 1 },
      uNoise: { value: getSharedNoiseTexture() },
      uSunResponse: { value: FACADE_SUN_RESPONSE },
    }]),
    /**
     * Outward only. A wall quad's +z is its outward normal (facadeRenderer builds the
     * instance basis from the footprint edge's outward normal), so FrontSide draws the
     * windowed face and nothing else. Under DoubleSide the same window grid, doors and
     * lit panes were also painted on the *inside* of every wall — visible straight
     * through any building whose far wall you could see over or past, and paid for twice
     * in fragments on a shader that is already the scene's most expensive.
     *
     * Shadows follow from this rather than being configured separately: Three casts a
     * FrontSide material from its back faces, which for a closed shell of zero-thickness
     * walls is exactly right — the shadow starts at the far wall, so a building's own lit
     * face never shadow-acnes against itself.
     */
    side: THREE.FrontSide,
    fog: true,
    lights: true,
  });

  materialsMap.set(profileKey, material);
  return material;
}
