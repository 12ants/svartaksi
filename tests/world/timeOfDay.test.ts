import { describe, expect, it } from 'vitest';
import {
  advanceTimeOfDay,
  moonDirection,
  sceneLighting,
  sunElevation,
  sunOffset,
  skyState,
  SUN_DISTANCE,
} from '../../src/world/timeOfDay';

describe('time of day', () => {
  it('places the sun at the horizon at sunrise/sunset and overhead at noon', () => {
    expect(sunElevation(6)).toBeCloseTo(0, 5);
    expect(sunElevation(18)).toBeCloseTo(0, 5);
    expect(sunElevation(12)).toBeCloseTo(1, 5);
  });

  it('lingers near the horizon through longer dawn and dusk transitions', () => {
    expect(sunElevation(7)).toBeGreaterThan(0);
    expect(sunElevation(7)).toBeLessThan(0.1);
    expect(sunElevation(17)).toBeGreaterThan(0);
    expect(sunElevation(17)).toBeLessThan(0.1);
  });

  it('places the sun straight down at midnight', () => {
    expect(sunElevation(0)).toBeCloseTo(-1, 5);
    expect(sunElevation(24)).toBeCloseTo(-1, 5);
  });

  it('wraps hours outside 0-24 the same as their in-range equivalent', () => {
    expect(sunElevation(30)).toBeCloseTo(sunElevation(6), 5);
    expect(sunElevation(-6)).toBeCloseTo(sunElevation(18), 5);
  });

  it('raises the sun offset above the car at noon and drops it below at midnight', () => {
    expect(sunOffset(12).y).toBeGreaterThan(0);
    expect(sunOffset(0).y).toBeLessThan(0);
  });

  it('is brightest and most neutral at noon, dim and cool at midnight', () => {
    const noon = skyState(12);
    const midnight = skyState(0);
    expect(noon.sunIntensity).toBeGreaterThan(midnight.sunIntensity);
    expect(noon.ambientIntensity).toBeGreaterThan(midnight.ambientIntensity);
    expect(midnight.ambientIntensity).toBeGreaterThanOrEqual(0.9);
    expect(midnight.ambientSkyColor.r).toBeGreaterThan(0.35);
    expect(midnight.ambientGroundColor.r).toBeGreaterThan(0.15);
    expect(midnight.backgroundColor.getHex()).toBe(0x050a18);
  });

  it('sun intensity rises and falls smoothly with the sun elevation across the day', () => {
    const samples = Array.from({ length: 96 }, (_, index) => skyState((index / 96) * 24).sunIntensity);
    for (const value of samples) expect(value).toBeGreaterThanOrEqual(0);
    // Noon (index 48) should be the brightest sample, midnight (index 0) the dimmest.
    const maxIndex = samples.indexOf(Math.max(...samples));
    const minIndex = samples.indexOf(Math.min(...samples));
    expect(Math.abs(maxIndex - 48)).toBeLessThanOrEqual(2);
    expect(minIndex === 0 || minIndex === samples.length - 1).toBe(true);
  });

  it('hides stars/moon in full daylight and shows them at night', () => {
    expect(skyState(12).starVisibility).toBe(0);
    expect(skyState(0).starVisibility).toBe(1);
  });

  it('ramps star/moon visibility smoothly across dusk instead of snapping on', () => {
    const dusk = skyState(18.5).starVisibility;
    const lateDusk = skyState(19).starVisibility;
    const night = skyState(22).starVisibility;
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
    expect(lateDusk).toBeGreaterThan(dusk);
    expect(night).toBe(1);
  });

  it('gives the sky a distinct zenith color from its horizon color', () => {
    const noon = skyState(12);
    expect(noon.zenithColor.getHex()).not.toBe(noon.backgroundColor.getHex());
  });

  it('puts the moon roughly opposite the sun', () => {
    const sun = sunOffset(12).normalize();
    const moon = moonDirection(12);
    expect(moon.dot(sun)).toBeCloseTo(-1, 5);
    expect(moon.length()).toBeCloseTo(1, 5);
  });

  it('hands the custom shaders the same lighting the real lights get', () => {
    // The custom-shader path and the DirectionalLight/HemisphereLight path have to agree
    // or the city is lit by a different sun than the ground it stands on.
    for (const hours of [3, 6, 9, 14, 18.5, 22]) {
      const sky = skyState(hours);
      const lighting = sceneLighting(hours);
      expect(lighting.sunColor.getHex()).toBe(sky.sunColor.getHex());
      expect(lighting.sunIntensity).toBe(sky.sunIntensity);
      expect(lighting.skyColor.getHex()).toBe(sky.ambientSkyColor.getHex());
      expect(lighting.groundColor.getHex()).toBe(sky.ambientGroundColor.getHex());
      expect(lighting.ambientIntensity).toBe(sky.ambientIntensity);
      expect(lighting.nightFactor).toBe(sky.starVisibility);
    }
  });

  it('gives the shaders the sun as a unit direction, not the position offset', () => {
    for (const hours of [6, 12, 18]) {
      const lighting = sceneLighting(hours);
      expect(lighting.sunDirection.length()).toBeCloseTo(1, 6);
      expect(lighting.sunDirection.dot(sunOffset(hours).normalize())).toBeCloseTo(1, 6);
    }
  });

  it('fades the street-lamp fill in with the night and leaves daylight untouched', () => {
    // Street lamps are emissive geometry, not real lights, so without this stand-in the
    // physically correct answer for asphalt at midnight is black — true, and unplayable.
    expect(sceneLighting(12).nightFill.getHex()).toBe(0x000000);
    expect(sceneLighting(14).nightFill.getHex()).toBe(0x000000);

    const midnight = sceneLighting(0).nightFill;
    const dusk = sceneLighting(19).nightFill;
    expect(midnight.r).toBeGreaterThan(0);
    expect(midnight.r).toBeGreaterThan(dusk.r);
    // Warm, like the lamp bulbs it stands in for — not a neutral grey lift.
    expect(midnight.r).toBeGreaterThan(midnight.b);
  });

  it('keeps the sun distance fixed so a shadow camera can bound its depth range', () => {
    for (const hours of [0, 5, 11, 17, 23]) {
      expect(sunOffset(hours).length()).toBeCloseTo(SUN_DISTANCE, 4);
    }
  });
});

describe('advanceTimeOfDay', () => {
  it('runs a full day in the cycle period and wraps across midnight', () => {
    expect(advanceTimeOfDay(0, 240)).toBeCloseTo(0, 6);
    expect(advanceTimeOfDay(6, 120)).toBeCloseTo(18, 6);
    // Past midnight comes back round to the small hours rather than running to 25.
    expect(advanceTimeOfDay(23.9, 10)).toBeCloseTo(0.9, 6);
  });

  it('holds still for a zero step', () => {
    expect(advanceTimeOfDay(9.25, 0)).toBeCloseTo(9.25, 6);
  });
});
