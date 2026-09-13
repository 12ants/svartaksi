import { describe, expect, it } from 'vitest';
import {
  cameraEaseTau,
  CAMERA_SETTING_BOUNDS,
  DEFAULT_CAMERA_SETTINGS,
  isDefaultCameraSettings,
  normalizeCameraSettings,
  type CameraSettings,
} from '../../src/svartaksi/cameraSettings';
import { CAMERA } from '../../src/svartaksi/gameplayConfig';

const settings = (patch: Partial<CameraSettings> = {}): CameraSettings =>
  ({ ...DEFAULT_CAMERA_SETTINGS, ...patch });

describe('normalizeCameraSettings', () => {
  it('answers a missing or malformed bag with the defaults', () => {
    for (const raw of [undefined, null, 'chase', 42, []]) {
      expect(normalizeCameraSettings(raw)).toEqual(DEFAULT_CAMERA_SETTINGS);
    }
  });

  it('falls back per field, so one bad dial does not discard the other three', () => {
    const result = normalizeCameraSettings({ distance: 1.5, pitch: 'up', responsiveness: NaN, fov: 70 });
    expect(result.distance).toBe(1.5);
    expect(result.fov).toBe(70);
    expect(result.pitch).toBe(DEFAULT_CAMERA_SETTINGS.pitch);
    expect(result.responsiveness).toBe(DEFAULT_CAMERA_SETTINGS.responsiveness);
  });

  it('clamps to the bounds the sliders offer, so stored data can never exceed them', () => {
    const high = normalizeCameraSettings({ distance: 99, pitch: 900, responsiveness: 4, fov: 179, lookAhead: 9 });
    const low = normalizeCameraSettings({ distance: -3, pitch: -900, responsiveness: -1, fov: 1, lookAhead: -2 });
    for (const key of ['distance', 'pitch', 'responsiveness', 'fov', 'lookAhead'] as const) {
      expect(high[key]).toBe(CAMERA_SETTING_BOUNDS[key].max);
      expect(low[key]).toBe(CAMERA_SETTING_BOUNDS[key].min);
    }
  });
});

describe('isDefaultCameraSettings', () => {
  it('recognises an untouched set, and any single dial moved off it', () => {
    expect(isDefaultCameraSettings(DEFAULT_CAMERA_SETTINGS)).toBe(true);
    expect(isDefaultCameraSettings({ ...DEFAULT_CAMERA_SETTINGS })).toBe(true);
    for (const key of ['distance', 'pitch', 'responsiveness', 'fov', 'lookAhead'] as const) {
      expect(isDefaultCameraSettings(settings({ [key]: DEFAULT_CAMERA_SETTINGS[key] + 1 }))).toBe(false);
    }
  });
});

describe('cameraEaseTau', () => {
  it('reproduces the pre-existing easing at the default responsiveness', () => {
    expect(cameraEaseTau(DEFAULT_CAMERA_SETTINGS.responsiveness)).toBeCloseTo(CAMERA.easeTau, 6);
  });

  it('is monotonically tighter as responsiveness rises, and never zero or negative', () => {
    const taus = [0, 0.2, 0.4, 0.6, 0.8, 1].map(cameraEaseTau);
    for (let index = 1; index < taus.length; index += 1) {
      expect(taus[index]).toBeLessThan(taus[index - 1]);
    }
    expect(taus[taus.length - 1]).toBeGreaterThan(0);
  });

  it('clamps out-of-range input rather than extrapolating to an absurd time constant', () => {
    expect(cameraEaseTau(-5)).toBe(cameraEaseTau(0));
    expect(cameraEaseTau(5)).toBe(cameraEaseTau(1));
  });
});
