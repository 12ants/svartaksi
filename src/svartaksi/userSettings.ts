/**
 * The player's own preferences, persisted between sessions.
 *
 * Render options (see world/renderOptions) and HUD region visibility (see
 * useHudVisibility) already had their own stores; this covers everything else the HUD
 * used to reset on every reload — which camera you were in, what time of day you set,
 * whether the sky was cycling, and which readouts you had switched on.
 *
 * Every field is validated on load rather than trusted: the value comes from
 * localStorage, which survives across versions of the app that did not have the same
 * fields, and a bad camera name or an out-of-range clock would otherwise reach the
 * runtime.
 */
import { isCameraMode, type CameraMode } from './cameraModes';
import { DEFAULT_CAMERA_SETTINGS, normalizeCameraSettings, type CameraSettings } from './cameraSettings';
import { isBlobControlScheme, type BlobControlScheme } from './playerInput';
import { DEFAULT_TIME_OF_DAY } from '../world/timeOfDay';

export interface UserSettings {
  cameraMode: CameraMode;
  /** How the follow camera is framed and how hard it chases — see cameraSettings.ts.
   * Persisted as a nested object rather than four flat fields so the normalizer that owns
   * their bounds is the one that validates them. */
  camera: CameraSettings;
  /** Which input scheme drives the blob character (see playerInput.ts) — a persisted
   * preference, same as cameraMode, so a player who prefers blobby's click-to-move
   * doesn't have to reselect it every session. */
  blobControlScheme: BlobControlScheme;
  timeOfDay: number;
  /** Run the clock on its own (see TIME_CYCLE_HOURS_PER_SECOND) instead of holding still. */
  autoTimeOfDay: boolean;
  showNearby: boolean;
  /** Off by default: the mid-screen SMS/message toast is opt-in, separate from zen mode. */
  showSmsToast: boolean;
  /** Floating diagnostic panels, hidden until enabled in the developer tools. */
  showDevPerf: boolean;
  showDevLog: boolean;
  showDevState: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  cameraMode: 'chase',
  camera: { ...DEFAULT_CAMERA_SETTINGS },
  blobControlScheme: 'direct',
  timeOfDay: DEFAULT_TIME_OF_DAY,
  autoTimeOfDay: false,
  showNearby: true,
  showSmsToast: false,
  showDevPerf: false,
  showDevLog: false,
  showDevState: false,
};

export const USER_SETTINGS_STORAGE_KEY = 'svartaksi:user-settings';

export function normalizeUserSettings(raw: unknown): UserSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_USER_SETTINGS };
  const input = raw as Record<string, unknown>;
  const settings = { ...DEFAULT_USER_SETTINGS };
  if (isCameraMode(input.cameraMode)) settings.cameraMode = input.cameraMode;
  // Always normalized, never merely copied: a build that predates these fields stored no
  // `camera` at all, and normalizeCameraSettings answers that with the defaults.
  settings.camera = normalizeCameraSettings(input.camera);
  if (isBlobControlScheme(input.blobControlScheme)) settings.blobControlScheme = input.blobControlScheme;
  if (typeof input.timeOfDay === 'number' && Number.isFinite(input.timeOfDay)) {
    settings.timeOfDay = ((input.timeOfDay % 24) + 24) % 24;
  }
  for (const flag of ['autoTimeOfDay', 'showNearby', 'showSmsToast', 'showDevPerf', 'showDevLog', 'showDevState'] as const) {
    if (typeof input[flag] === 'boolean') settings[flag] = input[flag];
  }
  return settings;
}

export function loadUserSettings(storage: Pick<Storage, 'getItem'>): UserSettings {
  try {
    const stored = storage.getItem(USER_SETTINGS_STORAGE_KEY);
    return stored ? normalizeUserSettings(JSON.parse(stored)) : { ...DEFAULT_USER_SETTINGS };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

export function saveUserSettings(storage: Pick<Storage, 'setItem'>, settings: UserSettings): void {
  try {
    storage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort.
  }
}
