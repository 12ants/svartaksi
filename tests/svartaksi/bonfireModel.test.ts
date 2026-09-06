import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { campLayout, flameLevel } from '../../src/svartaksi/bonfireCamp';
import { createBonfireCamp } from '../../src/svartaksi/bonfireModel';

describe('createBonfireCamp', () => {
  it('seats one pill per layout seat, facing where the layout says', () => {
    const seats = campLayout();
    const camp = createBonfireCamp(seats);
    expect(camp.pills).toHaveLength(seats.length);
    camp.pills.forEach((pill, index) => {
      expect(pill.position.x).toBeCloseTo(seats[index].offset.x);
      expect(pill.position.z).toBeCloseTo(seats[index].offset.z);
      expect(pill.rotation.y).toBeCloseTo(seats[index].yaw);
    });
    camp.dispose();
  });

  it('keeps the fire dark by day and lights it after dusk', () => {
    const camp = createBonfireCamp(campLayout());
    const light = camp.group.getObjectByName('bonfire:light') as THREE.PointLight;
    expect(light).toBeInstanceOf(THREE.PointLight);

    camp.update(4, 0);
    // A light at intensity 0 is still uniforms uploaded and a per-material test; by day
    // it is switched off outright.
    expect(light.intensity).toBe(0);
    expect(light.visible).toBe(false);

    camp.update(4, 1);
    expect(light.intensity).toBeGreaterThan(0);
    expect(light.visible).toBe(true);
    camp.dispose();
  });

  it('drives the flame from the clock alone, so the same time gives the same fire', () => {
    const first = createBonfireCamp(campLayout());
    const second = createBonfireCamp(campLayout());
    // The second camp is advanced through a different history before landing on the
    // same instant — an accumulator would disagree here, a pure function cannot.
    second.update(0.2, 1);
    second.update(11.4, 1);
    first.update(9.35, 1);
    second.update(9.35, 1);

    const flameOf = (camp: ReturnType<typeof createBonfireCamp>) =>
      camp.group.getObjectByName('bonfire:flame-outer') as THREE.Mesh;
    expect(flameOf(second).scale.toArray()).toEqual(flameOf(first).scale.toArray());
    expect(flameOf(first).scale.y).toBeCloseTo(flameLevel(9.35));
    first.dispose();
    second.dispose();
  });

  it('gives every pill a body that casts and receives', () => {
    const camp = createBonfireCamp(campLayout());
    for (const pill of camp.pills) {
      const body = pill.children[0] as THREE.Mesh;
      expect(body).toBeInstanceOf(THREE.Mesh);
      expect(body.castShadow).toBe(true);
      expect(body.receiveShadow).toBe(true);
    }
    camp.dispose();
  });

  it('builds the pit it burns in', () => {
    const camp = createBonfireCamp(campLayout());
    expect(camp.group.getObjectByName('bonfire:stones')).toBeInstanceOf(THREE.InstancedMesh);
    expect(camp.group.getObjectByName('bonfire:logs')).toBeInstanceOf(THREE.InstancedMesh);
    camp.dispose();
  });
});
