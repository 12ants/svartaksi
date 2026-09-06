import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { applyNightGlow, collectNightGlowMaterials, NIGHT_GLOW_INTENSITY } from '../../src/svartaksi/nightGlow';

function vehicle() {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xf04f36 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xffe2a1, emissive: 0xffc66b, emissiveIntensity: 1.2 });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), lamp));
  return { group, body, lamp };
}

describe('night glow', () => {
  it('lifts each surface by its own colour, so a red car glows red', () => {
    const { group, body } = vehicle();
    collectNightGlowMaterials(group);
    expect(body.emissive.getHex()).toBe(body.color.getHex());
  });

  it('leaves anything that was already emitting alone', () => {
    // Headlight lenses and lit displays are meant to be light sources and are tuned as
    // such; overwriting their emissive with their own albedo would dim them.
    const { group, lamp } = vehicle();
    const collected = collectNightGlowMaterials(group);
    expect(collected).not.toContain(lamp);
    expect(lamp.emissive.getHex()).toBe(0xffc66b);

    applyNightGlow(collected, 1);
    expect(lamp.emissiveIntensity).toBe(1.2);
  });

  it('is off in daylight and rises with the night', () => {
    const { group, body } = vehicle();
    const collected = collectNightGlowMaterials(group);

    applyNightGlow(collected, 0);
    expect(body.emissiveIntensity).toBe(0);

    applyNightGlow(collected, 1);
    expect(body.emissiveIntensity).toBeCloseTo(NIGHT_GLOW_INTENSITY, 6);
    // Separation, not illumination — this must not read as a light source.
    expect(NIGHT_GLOW_INTENSITY).toBeLessThan(0.5);
  });

  it('clamps a night factor outside 0..1 instead of over-driving the emissive', () => {
    const { group, body } = vehicle();
    const collected = collectNightGlowMaterials(group);
    applyNightGlow(collected, 4);
    expect(body.emissiveIntensity).toBeCloseTo(NIGHT_GLOW_INTENSITY, 6);
    applyNightGlow(collected, -2);
    expect(body.emissiveIntensity).toBe(0);
  });

  it('reports a material shared across meshes once', () => {
    const group = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial({ color: 0x334c59 });
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
    expect(collectNightGlowMaterials(group)).toHaveLength(1);
  });
});
