/**
 * The camera vocabulary, kept out of svartaksiRuntime so the HUD and the settings store can
 * both name a mode without importing the whole Three.js runtime.
 *
 * The order here is the order C cycles through, so it runs from the tightest view of the
 * vehicle outward and ends on the detached one: chase → hood → cockpit → orbit →
 * top-down → cinematic → freecam.
 */
export const CAMERA_MODES = [
  'chase', 'hood', 'cockpit', 'orbit', 'top-down', 'cinematic', 'freecam',
] as const;

export type CameraMode = typeof CAMERA_MODES[number];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  hood: 'Hood',
  cockpit: 'Cockpit',
  orbit: 'Orbit',
  'top-down': 'Top down',
  cinematic: 'Cinematic',
  freecam: 'Freecam',
};

export function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && (CAMERA_MODES as readonly string[]).includes(value);
}

/** The next mode in CAMERA_MODES, wrapping at the end. */
export function nextCameraMode(current: CameraMode): CameraMode {
  const index = CAMERA_MODES.indexOf(current);
  return CAMERA_MODES[(index + 1) % CAMERA_MODES.length];
}
