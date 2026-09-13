/**
 * The camera dials a player can actually turn: what they are, what range each may take,
 * and how to read a set of them back out of untrusted storage.
 *
 * Deliberately *not* a handful more numbers in `cameraRig.ts`'s per-body rigs. Those rigs exist
 * because a framing tuned around a 4.25m car frames mostly empty street around a 1.7m
 * pill, and there are four of them (vehicle, foot, horse, bus interior) with more likely
 * to follow. A preference expressed as absolute metres would have to be re-stated for
 * every one of them and would still be wrong for the next; expressed as a *transform on
 * whichever rig is active*, one setting means the same thing — "closer than this body's
 * normal framing" — whatever the player currently is. `cameraRig.ts`'s
 * `applyCameraSettings` is that transform: it lives next to the rigs whose geometry it
 * reasons about, so this module never has to know what a boom is.
 *
 * Pure, no three.js, no React: the settings store validates against this, and the HUD
 * renders its sliders straight off `CAMERA_SETTING_BOUNDS`.
 */
import { CAMERA } from './gameplayConfig';

export interface CameraSettings {
  /**
   * Multiplier on the active rig's framing distance — how far back the follow modes sit
   * and how high top-down flies. 1 is whatever that body's rig was tuned to.
   */
  distance: number;
  /**
   * Degrees added to the follow camera's elevation above the body it follows: positive
   * looks down from higher, negative drops toward eye level. In the first-person modes,
   * where the camera is already at eye height, it tilts the aim instead.
   */
  pitch: number;
  /**
   * How hard the camera chases its target pose. 0 is a long, floaty settle; 1 is bolted
   * to the rig. The default reproduces the fixed easing this had before the dial existed.
   */
  responsiveness: number;
  /** Vertical field of view, in degrees. */
  fov: number;
  /**
   * How hard the follow camera leads a corner — a multiplier on the predicted lead in
   * `cameraLookAhead.ts`, where 1 is the shipped strength and 0 is off.
   *
   * Zero is exactly off rather than nearly off, which is what lets this one dial also be
   * the reduced-motion control: a player who finds an anticipating camera uncomfortable
   * drags it to the bottom and the aim goes back to pointing exactly where the body
   * points, as it did before this existed.
   */
  lookAhead: number;
}

/**
 * Bounds for each dial, shared by the normalizer and the HUD sliders so a control can
 * never offer a value the normalizer would clamp away. `step` is the slider's granularity.
 */
export const CAMERA_SETTING_BOUNDS = {
  distance: { min: 0.45, max: 2.2, step: 0.05 },
  pitch: { min: -20, max: 45, step: 1 },
  responsiveness: { min: 0, max: 1, step: 0.01 },
  fov: { min: 35, max: 95, step: 1 },
  lookAhead: { min: 0, max: 2, step: 0.05 },
} as const satisfies Record<keyof CameraSettings, { min: number; max: number; step: number }>;

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  distance: 1,
  pitch: 0,
  // 0.5 lands exactly on CAMERA.easeTau — see cameraEaseTau.
  responsiveness: 0.5,
  fov: 48,
  // On by default, at the strength cameraLookAhead.ts's constants were chosen for: under
  // a metre of lead through ordinary town cornering, which reads as the corner opening up
  // rather than as the camera moving.
  lookAhead: 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Reads one dial off an untrusted bag (localStorage, a URL, an older build's saved
 * settings), falling back to the default rather than to a clamped `NaN`. */
function readSetting(input: Record<string, unknown>, key: keyof CameraSettings): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CAMERA_SETTINGS[key];
  const bounds = CAMERA_SETTING_BOUNDS[key];
  return clamp(value, bounds.min, bounds.max);
}

export function normalizeCameraSettings(raw: unknown): CameraSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CAMERA_SETTINGS };
  const input = raw as Record<string, unknown>;
  return {
    distance: readSetting(input, 'distance'),
    pitch: readSetting(input, 'pitch'),
    responsiveness: readSetting(input, 'responsiveness'),
    fov: readSetting(input, 'fov'),
    lookAhead: readSetting(input, 'lookAhead'),
  };
}

/**
 * Ends of the easing range, as exponential time constants in seconds.
 *
 * Their geometric mean is `CAMERA.easeTau`, which is what puts the default
 * `responsiveness` of 0.5 exactly on the value the camera used before this was
 * adjustable — the dial reframes the existing feel as its midpoint rather than moving it.
 * Geometric rather than linear interpolation because a time constant is a *rate*: halving
 * it is the same perceptual step wherever you are on the scale, so a linear slider over
 * seconds would spend most of its travel in the floaty end and cross the useful range in
 * its last centimetre.
 */
const EASE_TAU_FLOATY = CAMERA.easeTau * 3;
const EASE_TAU_TIGHT = CAMERA.easeTau / 3;

/** The exponential time constant (seconds) the follow camera should settle with. */
export function cameraEaseTau(responsiveness: number): number {
  const amount = clamp(responsiveness, 0, 1);
  return EASE_TAU_FLOATY * Math.pow(EASE_TAU_TIGHT / EASE_TAU_FLOATY, amount);
}

/**
 * Whether a set of dials is untouched. Lives here rather than in the HUD that asks the
 * question, because "are these the defaults" is a fact about the settings and the cast
 * `Object.keys` needs belongs next to the type that justifies it.
 */
export function isDefaultCameraSettings(settings: CameraSettings): boolean {
  return (Object.keys(DEFAULT_CAMERA_SETTINGS) as (keyof CameraSettings)[])
    .every((key) => settings[key] === DEFAULT_CAMERA_SETTINGS[key]);
}
