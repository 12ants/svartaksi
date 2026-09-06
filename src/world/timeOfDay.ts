/**
 * Pure time-of-day → lighting model. A single 0-24h value drives both the sun's
 * position (via its offset from the car) and the skybox (background/fog/ambient),
 * so the two always agree — the sun visibly sets exactly as the sky reddens and dims.
 */
import * as THREE from 'three';
import type { SceneLighting } from './shaderLighting';

export const DEFAULT_TIME_OF_DAY = 22;

/**
 * How fast the clock runs when it is cycling on its own: a full day every four minutes.
 * Slow enough that a dawn or a dusk lasts long enough to watch the light change across
 * the city, fast enough that you never wait long for one.
 */
export const TIME_CYCLE_HOURS_PER_SECOND = 24 / 240;

/** Advances the clock by `seconds` of real time, wrapping across midnight. */
export function advanceTimeOfDay(hours: number, seconds: number): number {
  const advanced = hours + seconds * TIME_CYCLE_HOURS_PER_SECOND;
  return ((advanced % 24) + 24) % 24;
}

export interface SkyState {
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Sky color at the horizon — also used as the fog color, so distant ground fades
   * into the same band the dome shows at eye level. */
  backgroundColor: THREE.Color;
  /** Sky color straight up — the top of the sky dome's gradient. */
  zenithColor: THREE.Color;
  ambientSkyColor: THREE.Color;
  ambientGroundColor: THREE.Color;
  ambientIntensity: number;
  /** 0 (full daylight, stars/moon invisible) .. 1 (full night) — drives the sky
   * dome's star field and moon opacity so both fade in together at dusk. */
  starVisibility: number;
  /** Direction from the car to the moon, opposite the sun — a deliberately simplified
   * "moon rises as the sun sets" model rather than a real lunar orbit/phase. */
  moonDirection: THREE.Vector3;
}

interface SkyStop {
  /** Sun elevation this stop applies at: -1 straight down (midnight) .. 1 straight up (noon). */
  elevation: number;
  sunColor: number;
  sunIntensity: number;
  background: number;
  zenith: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
}

/**
 * Hand-placed gradient stops rather than a physical sky model — cheap, and the only
 * requirement here is that it reads as a believable day/night cycle.
 *
 * The ambient intensities used to be roughly twice these. That was compensating for the
 * sun reaching almost nothing: roads and building facades render through custom shaders
 * that Three's directional light never touched, so ambient was the only light most of
 * the visible city received, and it had to be cranked to keep the place from going
 * black. Now that those shaders are on the same sun as everything else (shaderLighting),
 * that compensation is pure overexposure — it washed the terrain to near-white and
 * flattened every surface it lit. Sun intensity comes down more gently, since it is now
 * doing real work on far more of the frame than it was.
 *
 * Night ambient lifts unlit props and terrain while LAMP_FILL keeps streets readable.
 */
const SKY_STOPS: SkyStop[] = [
  { elevation: -1, sunColor: 0x2b3a67, sunIntensity: 0.1, background: 0x050a18, zenith: 0x010412, ambientSky: 0xa4b5d2, ambientGround: 0x748198, ambientIntensity: 0.9 },
  { elevation: -0.15, sunColor: 0x35406b, sunIntensity: 0.3, background: 0x112342, zenith: 0x09132b, ambientSky: 0xa8bad2, ambientGround: 0x788498, ambientIntensity: 0.95 },
  { elevation: 0, sunColor: 0xff7a4d, sunIntensity: 1.5, background: 0xd97a4d, zenith: 0x3a5f85, ambientSky: 0xffb37a, ambientGround: 0x3a2a22, ambientIntensity: 0.7 },
  { elevation: 0.35, sunColor: 0xffe2ad, sunIntensity: 2.3, background: 0x9db9c6, zenith: 0x4a80b5, ambientSky: 0xcfe6ef, ambientGround: 0x3c4636, ambientIntensity: 0.95 },
  { elevation: 1, sunColor: 0xfff0cf, sunIntensity: 2.6, background: 0x91aeb7, zenith: 0x2f7fb8, ambientSky: 0xd9f0ff, ambientGround: 0x49513e, ambientIntensity: 1.1 },
];

/** How far below the horizon the sun needs to sink before the sky is fully "night" —
 * stars/moon ramp in smoothly across this band (roughly sunset to ~2h after) rather
 * than snapping on right at sunset. */
const NIGHT_ELEVATION_BAND: [number, number] = [0.05, -0.5];

/** How far the sun sits from the car. Constant for every hour — only its direction
 * changes — so it also fixes the depth range a shadow camera has to cover. */
export const SUN_DISTANCE = 320;
/** Horizontal (east-west/north-south) bearing the sun swings along — matches the
 * old fixed offset's bearing so a noon-ish default still looks like the original. */
const SUN_HORIZONTAL_AXIS = new THREE.Vector2(-180, 100).normalize();

function normalizeHours(hours: number): number {
  return ((hours % 24) + 24) % 24;
}

/**
 * How much the sun's angular speed varies across the day, on top of the plain
 * constant-speed sinusoid. Slows the sun down near the horizon (elevation 0 — sunrise
 * and sunset, where SKY_STOPS' dawn/dusk gradient lives) and speeds it up near the top
 * and bottom of its arc (noon and midnight, the steady day/night stops), so the warm
 * transition light lingers longer per clock-hour and the steady day/night phases pass
 * quicker. Must stay below 1 — at 1 the sun would momentarily stop (and above it,
 * reverse) right at the horizon instead of merely slowing down.
 */
const HORIZON_LINGER = 0.7;

function sunTheta(hours: number): number {
  const theta0 = (Math.PI / 12) * (normalizeHours(hours) - 6);
  return theta0 - (HORIZON_LINGER / 2) * Math.sin(2 * theta0);
}

/** -1 (midnight, straight down) .. 1 (noon, straight up). */
export function sunElevation(hours: number): number {
  return Math.sin(sunTheta(hours));
}

/** Offset from the car to the sun for this time of day (not an absolute position). */
export function sunOffset(hours: number): THREE.Vector3 {
  const theta = sunTheta(hours);
  const elevation = Math.sin(theta);
  const horizontal = Math.cos(theta);
  return new THREE.Vector3(
    SUN_HORIZONTAL_AXIS.x * horizontal * SUN_DISTANCE,
    elevation * SUN_DISTANCE,
    SUN_HORIZONTAL_AXIS.y * horizontal * SUN_DISTANCE,
  );
}

function lerpColor(a: number, b: number, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

/** 0 in full daylight, ramping to 1 as the sun sinks through NIGHT_ELEVATION_BAND below
 * the horizon — drives how visible the sky dome's stars/moon are. */
function nightFactor(elevation: number): number {
  const [start, end] = NIGHT_ELEVATION_BAND;
  return THREE.MathUtils.clamp((start - elevation) / (start - end), 0, 1);
}

/** Direction from the car to the moon: a deliberately simplified model where the moon
 * sits exactly opposite the sun (same horizontal axis, mirrored elevation), so it rises
 * as the sun sets and sets as the sun rises rather than following a real lunar orbit. */
export function moonDirection(hours: number): THREE.Vector3 {
  return sunOffset(hours).multiplyScalar(-1).normalize();
}

export function skyState(hours: number): SkyState {
  const elevation = sunElevation(hours);
  let lower = SKY_STOPS[0];
  let upper = SKY_STOPS[SKY_STOPS.length - 1];
  for (let index = 0; index < SKY_STOPS.length - 1; index += 1) {
    if (elevation >= SKY_STOPS[index].elevation && elevation <= SKY_STOPS[index + 1].elevation) {
      lower = SKY_STOPS[index];
      upper = SKY_STOPS[index + 1];
      break;
    }
  }
  const span = upper.elevation - lower.elevation;
  const t = span > 0 ? (elevation - lower.elevation) / span : 0;
  return {
    sunColor: lerpColor(lower.sunColor, upper.sunColor, t),
    sunIntensity: THREE.MathUtils.lerp(lower.sunIntensity, upper.sunIntensity, t),
    backgroundColor: lerpColor(lower.background, upper.background, t),
    zenithColor: lerpColor(lower.zenith, upper.zenith, t),
    ambientSkyColor: lerpColor(lower.ambientSky, upper.ambientSky, t),
    ambientGroundColor: lerpColor(lower.ambientGround, upper.ambientGround, t),
    ambientIntensity: THREE.MathUtils.lerp(lower.ambientIntensity, upper.ambientIntensity, t),
    starVisibility: nightFactor(elevation),
    moonDirection: moonDirection(hours),
  };
}

/**
 * The same lighting skyState() hands the scene's DirectionalLight/HemisphereLight,
 * reshaped for the custom shaders (see shaderLighting.ts) so both are driven by one
 * number. Deriving it here rather than letting each shader read the sky state directly
 * keeps `sunDirection` — the one value the real lights express as a *position offset*
 * and the shaders need as a normalized direction — converted in exactly one place.
 */
/** Warm sodium tone of the street-lamp bulbs the fill stands in for (matches the bulb
 * material in threeWorld.ts), and how hard it drives at full night. Tuned so asphalt —
 * the darkest large surface in the world, and the one you most need to see — stays
 * clearly readable without the streets reading as daylit. */
const LAMP_FILL_COLOR = 0xffd9a0;
const LAMP_FILL_STRENGTH = 2.3;

export function sceneLighting(hours: number): SceneLighting {
  const sky = skyState(hours);
  return {
    sunDirection: sunOffset(hours).normalize(),
    sunColor: sky.sunColor,
    sunIntensity: sky.sunIntensity,
    skyColor: sky.ambientSkyColor,
    groundColor: sky.ambientGroundColor,
    ambientIntensity: sky.ambientIntensity,
    nightFactor: sky.starVisibility,
    nightFill: new THREE.Color(LAMP_FILL_COLOR).multiplyScalar(LAMP_FILL_STRENGTH * sky.starVisibility),
  };
}
