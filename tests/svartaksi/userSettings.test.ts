import { describe, expect, it } from 'vitest';

import {
  DEFAULT_USER_SETTINGS,
  USER_SETTINGS_STORAGE_KEY,
  loadUserSettings,
  normalizeUserSettings,
  saveUserSettings,
} from '../../src/svartaksi/userSettings';
import { CAMERA_SETTING_BOUNDS, DEFAULT_CAMERA_SETTINGS } from '../../src/svartaksi/cameraSettings';

/** A `Storage`-shaped pair backed by a Map — enough for the two calls these tests make.
 * The Map is handed back too, so a test can assert on what was actually written. */
function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

describe('user settings', () => {
  it('round-trips every preference through storage', () => {
    const storage = memoryStorage();
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      cameraMode: 'orbit' as const,
      timeOfDay: 21.5,
      autoTimeOfDay: true,
      showNearby: false,
      showSmsToast: true,
      showDevPerf: true,
      showDevLog: true,
      showDevState: true,
    };

    saveUserSettings(storage, settings);
    expect(loadUserSettings(storage)).toEqual(settings);
    expect(storage.store.has(USER_SETTINGS_STORAGE_KEY)).toBe(true);
  });

  it('falls back to defaults for absent, unparseable or wrongly typed values', () => {
    expect(normalizeUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
    expect(normalizeUserSettings('nonsense')).toEqual(DEFAULT_USER_SETTINGS);
    expect(normalizeUserSettings({})).toEqual(DEFAULT_USER_SETTINGS);
    expect(normalizeUserSettings({ showNearby: 'yes', timeOfDay: 'noon' }))
      .toEqual(DEFAULT_USER_SETTINGS);
    expect(loadUserSettings({ getItem: () => '{{{' })).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('rejects a camera mode this build no longer has', () => {
    // localStorage outlives the build that wrote it, and an unknown mode would otherwise
    // reach the runtime and match none of its camera branches.
    expect(normalizeUserSettings({ cameraMode: 'helicopter' }).cameraMode)
      .toBe(DEFAULT_USER_SETTINGS.cameraMode);
    expect(normalizeUserSettings({ cameraMode: 'freecam' }).cameraMode).toBe('freecam');
  });

  it('rejects a blob control scheme this build no longer has', () => {
    expect(normalizeUserSettings({ blobControlScheme: 'mouse-orbit' }).blobControlScheme)
      .toBe(DEFAULT_USER_SETTINGS.blobControlScheme);
    expect(normalizeUserSettings({ blobControlScheme: 'blobby' }).blobControlScheme).toBe('blobby');
  });

  it('wraps a stored clock back into 0-24 rather than passing it through', () => {
    expect(normalizeUserSettings({ timeOfDay: 26 }).timeOfDay).toBe(2);
    expect(normalizeUserSettings({ timeOfDay: -3 }).timeOfDay).toBe(21);
    expect(normalizeUserSettings({ timeOfDay: Number.POSITIVE_INFINITY }).timeOfDay)
      .toBe(DEFAULT_USER_SETTINGS.timeOfDay);
  });
});

describe('camera settings', () => {
  it('gives a build that predates the camera dials the defaults rather than undefined', () => {
    const settings = normalizeUserSettings({ cameraMode: 'orbit', timeOfDay: 9 });
    expect(settings.camera).toEqual(DEFAULT_CAMERA_SETTINGS);
  });

  it('keeps a saved camera framing across a reload', () => {
    const camera = { distance: 1.4, pitch: 12, responsiveness: 0.8, fov: 62 };
    const storage = memoryStorage();
    saveUserSettings(storage, { ...DEFAULT_USER_SETTINGS, camera });
    expect(loadUserSettings(storage).camera).toEqual(camera);
  });

  it('validates the stored dials rather than trusting them', () => {
    const settings = normalizeUserSettings({ camera: { distance: 500, pitch: 'high', fov: 62 } });
    expect(settings.camera.distance).toBe(CAMERA_SETTING_BOUNDS.distance.max);
    expect(settings.camera.pitch).toBe(DEFAULT_CAMERA_SETTINGS.pitch);
    expect(settings.camera.fov).toBe(62);
  });
});
