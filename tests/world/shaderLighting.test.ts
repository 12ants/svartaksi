import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  applySceneLighting,
  createSceneLightingUniforms,
  SCENE_LIGHTING_PARS_GLSL,
  type SceneLighting,
} from '../../src/world/shaderLighting';

function lighting(): SceneLighting {
  return {
    sunDirection: new THREE.Vector3(0.2, 0.9, -0.3).normalize(),
    sunColor: new THREE.Color(0xff8844),
    sunIntensity: 1.75,
    skyColor: new THREE.Color(0x99ccff),
    groundColor: new THREE.Color(0x332211),
    ambientIntensity: 0.65,
    nightFactor: 0.4,
    nightFill: new THREE.Color(0x664422),
  };
}

describe('scene lighting contract', () => {
  it('declares in GLSL exactly the uniforms the factory creates', () => {
    // The two are the two halves of one contract — a name that exists on only one side
    // is a uniform that silently never updates.
    const declared = [...SCENE_LIGHTING_PARS_GLSL.matchAll(/uniform\s+\w+\s+(u\w+)\s*;/g)]
      .map((match) => match[1])
      .sort();
    expect(Object.keys(createSceneLightingUniforms()).sort()).toEqual(declared);
  });

  it('copies every field of a lighting state into a material', () => {
    const material = new THREE.ShaderMaterial({ uniforms: createSceneLightingUniforms() });
    const state = lighting();

    applySceneLighting(material, state);

    expect(material.uniforms.uSunDirection.value.toArray()).toEqual(state.sunDirection.toArray());
    expect(material.uniforms.uSunColor.value.getHex()).toBe(state.sunColor.getHex());
    expect(material.uniforms.uSkyColor.value.getHex()).toBe(state.skyColor.getHex());
    expect(material.uniforms.uGroundColor.value.getHex()).toBe(state.groundColor.getHex());
    expect(material.uniforms.uSunIntensity.value).toBe(state.sunIntensity);
    expect(material.uniforms.uAmbientIntensity.value).toBe(state.ambientIntensity);
    expect(material.uniforms.uNightFactor.value).toBe(state.nightFactor);
    expect(material.uniforms.uNightFill.value.getHex()).toBe(state.nightFill.getHex());
  });

  it('copies into the material rather than aliasing the caller state', () => {
    // ThreeWorld caches one lighting state and re-applies it after every rebuild; if
    // materials aliased it, mutating the cache would silently reach into the GPU.
    const material = new THREE.ShaderMaterial({ uniforms: createSceneLightingUniforms() });
    const state = lighting();
    applySceneLighting(material, state);

    expect(material.uniforms.uSunColor.value).not.toBe(state.sunColor);
    expect(material.uniforms.uSunDirection.value).not.toBe(state.sunDirection);
  });

  it('skips a material that predates the contract instead of throwing', () => {
    const material = new THREE.ShaderMaterial({ uniforms: { uSunIntensity: { value: 0 } } });
    expect(() => applySceneLighting(material, lighting())).not.toThrow();
    expect(material.uniforms.uSunIntensity.value).toBe(1.75);
  });

  it('normalizes direct and ambient the way MeshStandardMaterial does', () => {
    // Without BRDF_Lambert's reciprocal, a road renders pi times brighter than the
    // ground it sits on despite both being lit by the same two lights.
    expect(SCENE_LIGHTING_PARS_GLSL).toContain('RECIPROCAL_PI');
  });
});
