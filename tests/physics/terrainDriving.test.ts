import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPhysicsWorld } from '../../src/physics/world';
import { applyCarControls, createCarVehicle } from '../../src/svartaksi/carPhysics';
import {
  computeTerrainClearance,
  DEFAULT_TERRAIN_SETTINGS,
  terrainHeightAt,
  type TerrainSettings,
} from '../../src/world/terrain';
import type { WorldArea } from '../../src/world/types';

/** A wood filling z from 40 to 240, so a car starting at the origin drives into its
 * southern edge head-on. */
const wood: WorldArea = {
  id: 'wood',
  kind: 'wood',
  rings: [[{ x: -200, z: 40 }, { x: 200, z: 40 }, { x: 200, z: 240 }, { x: -200, z: 240 }]],
};

function drive(settings: TerrainSettings, seconds: number) {
  const terrain = computeTerrainClearance([wood], settings);
  const world = createPhysicsWorld();
  world.setGroundHeight((x, z) => terrainHeightAt({ x, z }, terrain));
  const vehicle = createCarVehicle();
  vehicle.chassis.position.set(0, 0.6, 0);
  world.addBody(vehicle.chassis);
  world.addVehicle(vehicle);
  const dt = 1 / 60;
  for (let step = 0; step < Math.round(seconds / dt); step += 1) {
    applyCarControls(vehicle, { forward: 1, turn: 0, brake: false, boost: false }, dt);
    world.step(dt);
  }
  return { vehicle, terrain };
}

describe('driving on landuse terrain', () => {
  it('climbs the bank at a wood\'s edge and ends up standing on the mound', () => {
    const { vehicle, terrain } = drive(DEFAULT_TERRAIN_SETTINGS, 6);
    // Well past the ramp, which runs about six metres in from the edge at z=40.
    expect(vehicle.chassis.position.z).toBeGreaterThan(60);
    const ground = terrainHeightAt(
      { x: vehicle.chassis.position.x, z: vehicle.chassis.position.z },
      terrain,
    );
    expect(ground).toBeCloseTo(terrain[0].height, 5);
    // Riding on its suspension on top of the mound, not buried in it or thrown over it.
    expect(vehicle.chassis.position.y - ground).toBeGreaterThan(0.4);
    expect(vehicle.chassis.position.y - ground).toBeLessThan(0.9);
  });

  it('keeps all four wheels on the ground going over the edge', () => {
    const { vehicle } = drive(DEFAULT_TERRAIN_SETTINGS, 6);
    expect(vehicle.wheels.every((wheel) => wheel.grounded)).toBe(true);
  });

  it('leans back as it climbs, which is the bank being felt rather than teleported over', () => {
    const terrain = computeTerrainClearance([wood], DEFAULT_TERRAIN_SETTINGS);
    const world = createPhysicsWorld();
    world.setGroundHeight((x, z) => terrainHeightAt({ x, z }, terrain));
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(0, 0.6, 34);
    world.addBody(vehicle.chassis);
    world.addVehicle(vehicle);
    const dt = 1 / 60;
    let steepest = 0;
    for (let step = 0; step < 240; step += 1) {
      applyCarControls(vehicle, { forward: 1, turn: 0, brake: false, boost: false }, dt);
      world.step(dt);
      const pitch = new THREE.Euler().setFromQuaternion(vehicle.chassis.quaternion, 'YXZ').x;
      steepest = Math.max(steepest, Math.abs(pitch));
    }
    expect(steepest).toBeGreaterThan(0.05);
  });

  it('is stopped by the same edge when the slope is turned off, which is the wall it used to be', () => {
    // The control for all of the above: with a vertical side the polygon boundary is a
    // metre of sheer cliff, and no amount of throttle gets a car up it.
    const { vehicle } = drive({ ...DEFAULT_TERRAIN_SETTINGS, slope: 0 }, 6);
    expect(vehicle.chassis.position.z).toBeLessThan(45);
  });

  it('gives a taller world a steeper climb, not a taller wall', () => {
    const tall = { ...DEFAULT_TERRAIN_SETTINGS, scale: 4 };
    const terrain = computeTerrainClearance([wood], tall);
    // The ramp grows with the height, so the gradient stays where the slope setting put
    // it however far the height slider is pushed.
    const gradient = terrain[0].height / terrain[0].ramp;
    expect(gradient).toBeCloseTo(1 / tall.slope, 6);
    const { vehicle } = drive(tall, 8);
    expect(vehicle.chassis.position.z).toBeGreaterThan(80);
  });
});
