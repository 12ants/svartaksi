import { describe, expect, it } from 'vitest';

import { createCarModel, isCarBraking, setCarLights } from '../../src/svartaksi/carModel';

const DAY = { nightFactor: 0, braking: false, reversing: false };
const NIGHT = { nightFactor: 1, braking: false, reversing: false };

describe('car brake detection', () => {
  it('lights the brakes when the brake is applied at speed', () => {
    expect(isCarBraking(true, 0, 12)).toBe(true);
    expect(isCarBraking(true, 0, -3)).toBe(true);
  });

  it('leaves them off when the brake is held on an already-stopped car', () => {
    // Sitting still with a foot on the pedal is not a signal anyone behind needs, and
    // a parked car glowing red all night reads as broken.
    expect(isCarBraking(true, 0, 0)).toBe(false);
  });

  it('lights them when reverse is selected while still rolling forwards', () => {
    // In these controls that is how you stop hard without the brake key, so a following
    // driver has exactly as much right to see it.
    expect(isCarBraking(false, -1, 8)).toBe(true);
  });

  it('leaves them off for coasting and for reversing proper', () => {
    expect(isCarBraking(false, 0, 12)).toBe(false);
    expect(isCarBraking(false, 1, 12)).toBe(false);
    expect(isCarBraking(false, -1, -4)).toBe(false);
  });
});

describe('car lights', () => {
  it('keeps the headlights off and dark in daylight', () => {
    const model = createCarModel();
    setCarLights(model, DAY);
    expect(model.headlights[0].intensity).toBe(0);
    expect(model.headlights[1].intensity).toBe(0);
    expect(model.headlightLensMaterial.emissiveIntensity).toBe(0);
    expect(model.tailLensMaterial.emissiveIntensity).toBe(0);
  });

  it('brings the headlights and tail lamps up together after dark', () => {
    const model = createCarModel();
    setCarLights(model, NIGHT);
    expect(model.headlights[0].intensity).toBeGreaterThan(0);
    expect(model.headlightLensMaterial.emissiveIntensity).toBeGreaterThan(0);
    expect(model.tailLensMaterial.emissiveIntensity).toBeGreaterThan(0);
  });

  it('waits for dusk rather than fading the headlights up from noon', () => {
    const model = createCarModel();
    setCarLights(model, { ...DAY, nightFactor: 0.2 });
    expect(model.headlights[0].intensity).toBe(0);
    setCarLights(model, { ...DAY, nightFactor: 0.5 });
    expect(model.headlights[0].intensity).toBeGreaterThan(0);
  });

  it('lights the brakes at noon as readily as at midnight', () => {
    // A brake light that only worked after dark would be the one obviously wrong thing
    // about the car.
    const model = createCarModel();
    setCarLights(model, { ...DAY, braking: true });
    const byDay = model.tailLensMaterial.emissiveIntensity;
    expect(byDay).toBeGreaterThan(0);

    setCarLights(model, { ...NIGHT, braking: true });
    expect(model.tailLensMaterial.emissiveIntensity).toBe(byDay);
  });

  it('makes braking clearly brighter than the tail lamps it shares a lens with', () => {
    const model = createCarModel();
    setCarLights(model, NIGHT);
    const tail = model.tailLensMaterial.emissiveIntensity;
    setCarLights(model, { ...NIGHT, braking: true });
    expect(model.tailLensMaterial.emissiveIntensity).toBeGreaterThan(tail * 2);
  });

  it('lights the reversing lamps only in reverse', () => {
    const model = createCarModel();
    setCarLights(model, NIGHT);
    expect(model.reverseLensMaterial.emissiveIntensity).toBe(0);
    setCarLights(model, { ...NIGHT, reversing: true });
    expect(model.reverseLensMaterial.emissiveIntensity).toBeGreaterThan(0);
  });

  it('adds exactly two dynamic lights to the scene', () => {
    // Three's forward renderer charges every lit fragment in the scene per light, so
    // the count here is a budget, not an implementation detail.
    const model = createCarModel();
    const lights = model.group.children.filter((child) => 'isLight' in child && child.isLight);
    expect(lights).toHaveLength(2);
  });
});
