import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createPersonModel,
  PERSON_CENTER_Y,
  PERSON_EYE_Y,
  PERSON_OPACITY,
} from '../../src/svartaksi/personModel';

describe('player pill', () => {
  it('settles body and visor opacity at exactly 0.4', () => {
    expect(PERSON_OPACITY).toBe(0.4);
  });

  it('starts fully invisible, because every appearance it makes is a fade-in', () => {
    const { materials } = createPersonModel();

    expect(materials).toHaveLength(2);
    for (const material of materials) {
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBe(0);
    }
  });

  it('stands with its feet at the group origin, so position.y is the surface underneath', () => {
    const { group } = createPersonModel();
    const body = group.getObjectByName('person:body') as THREE.Mesh;

    expect(body.position.y).toBe(PERSON_CENTER_Y);
    // Capsule half-height plus its cap radius: the lowest point sits exactly at y=0.
    expect(PERSON_CENTER_Y - (1.02 / 2 + 0.32)).toBeCloseTo(0, 10);
  });

  it('carries a visor at eye height, so the pill reads as facing somewhere', () => {
    const { group } = createPersonModel();
    const visor = group.getObjectByName('person:visor') as THREE.Mesh;

    expect(visor.position.y).toBeCloseTo(PERSON_EYE_Y - 0.1, 6);
    // Forward is +z, and the visor is what makes that readable from the chase camera.
    expect(visor.position.z).toBeGreaterThan(0);
  });

  it('receives shadows on the body, and waits to cast one until it has faded in', () => {
    const { group } = createPersonModel();
    const body = group.getObjectByName('person:body') as THREE.Mesh;

    expect(body.receiveShadow).toBe(true);
    // The shadow map has no notion of opacity: a caster at opacity 0 still lays a solid
    // capsule on the pavement with nothing standing over it. The runtime switches this
    // on once the fade-in is far enough along — see PERSON_SHADOW_FADE.
    expect(body.castShadow).toBe(false);
  });
});
