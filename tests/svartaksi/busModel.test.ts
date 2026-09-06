import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { computeAckermannAngles } from '../../src/svartaksi/busGeometry';
import {
  BUS_AISLE_HALF_WIDTH,
  BUS_DOOR_BACK_Z,
  BUS_DOOR_FRONT_Z,
  BUS_DOOR_OPEN_ANGLE,
  BUS_FRONT_AXLE_Z,
  BUS_HALF_TRACK,
  BUS_INTERIOR_HALF_LENGTH,
  BUS_INTERIOR_HALF_WIDTH,
  BUS_MAX_STEER,
  BUS_REAR_AXLE_Z,
  BUS_SEAT_COLLIDERS,
  BUS_WHEELBASE,
  clampToBusFloor,
  computeRiderWorldPosition,
  createBusModel,
  exportBusModelToGLB,
  exportBusModelToGLTF,
  resolveAgainstBusSeats,
  setBusDisplayText,
  setBusDoorOpen,
  setBusNextStop,
  setBusNightFactor,
  setBusProximity,
  setBusSteer,
  setBusWheelRoll,
} from '../../src/svartaksi/busModel';

function descendants(model: ReturnType<typeof createBusModel>) {
  const objects: THREE.Object3D[] = [];
  model.group.traverse((object) => objects.push(object));
  return objects;
}

describe('bus model', () => {
  it('has a muted-red shell, dark floor, left-side driver partition, and clear doorway', () => {
    const model = createBusModel();
    const floor = model.group.getObjectByName('bus:floor') as THREE.Mesh;
    const body = model.group.getObjectByName('bus:body-roof') as THREE.Mesh;
    const partition = model.group.getObjectByName('bus:driver-partition');
    const driver = model.group.getObjectByName('bus:driver');
    const seats = descendants(model).filter((object) => object.name.startsWith('bus:seat'));

    expect((body.material as THREE.MeshStandardMaterial).color.r)
      .toBeGreaterThan((body.material as THREE.MeshStandardMaterial).color.b);
    expect((floor.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x17191a);
    expect(partition?.position.x).toBeGreaterThan(0);
    expect(driver?.position.x).toBeGreaterThan(0);
    expect(seats.some((seat) => seat.position.x < 0 && seat.position.z > -3.1 && seat.position.z < -1.3)).toBe(false);
    expect(BUS_DOOR_OPEN_ANGLE).toBeCloseTo(-Math.PI / 2);
    model.dispose();
  });

  it('uses exactly two shadowless headlights and enables them at night', () => {
    const model = createBusModel();
    const lights = descendants(model).filter((object): object is THREE.SpotLight => object instanceof THREE.SpotLight);
    expect(lights).toHaveLength(2);
    expect(lights.map((light) => light.name)).toEqual([
      'bus:headlight-left',
      'bus:headlight-right',
    ]);
    expect(lights.every((light) => !light.castShadow && light.intensity === 0)).toBe(true);

    setBusNightFactor(model, 0.34);
    expect(lights.every((light) => light.intensity === 0)).toBe(true);
    setBusNightFactor(model, 0.35);
    expect(lights.every((light) => light.intensity > 0)).toBe(true);
    model.dispose();
  });

  it('builds deterministic fixed scruff patch transforms', () => {
    const first = createBusModel();
    const second = createBusModel();
    const transforms = (model: typeof first) => descendants(model)
      .filter((object) => object.name.startsWith('bus:scruff-'))
      .map((object) => [object.position.toArray(), object.rotation.toArray(), object.scale.toArray()]);

    expect(transforms(first)).toHaveLength(8);
    expect(transforms(second)).toEqual(transforms(first));
    first.dispose();
    second.dispose();
  });

  it('updates the amber display only when text changes and disposes resources once', () => {
    const model = createBusModel();
    const texture = (model.display.material as THREE.MeshBasicMaterial).map!;
    const initialVersion = texture.version;
    setBusDisplayText(model, 'Strandvägen');
    expect(model.display.userData.text).toBe('STRANDVÄGEN');
    expect(texture.version).toBeGreaterThan(initialVersion);
    const unchangedVersion = texture.version;
    setBusDisplayText(model, 'Strandvägen');
    expect(texture.version).toBe(unchangedVersion);

    const geometry = model.display.geometry;
    const material = model.display.material as THREE.Material;
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const textureDispose = vi.spyOn(texture, 'dispose');
    model.dispose();
    model.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });

  it('exports to glTF JSON with the expected structure', async () => {
    const model = createBusModel();
    const json = await exportBusModelToGLTF(model);
    const doc = JSON.parse(json);

    expect(doc.asset.version).toBe('2.0');
    expect(doc.scenes).toBeDefined();
    expect(doc.meshes.length).toBeGreaterThan(0);
    expect(doc.meshes.some((m: { primitives: { attributes: { POSITION?: unknown } }[] }) =>
      m.primitives.some((p) => p.attributes.POSITION !== undefined))).toBe(true);
    model.dispose();
  });

  it('exports to GLB binary starting with the glTF magic header', async () => {
    const model = createBusModel();
    const buffer = await exportBusModelToGLB(model);
    const view = new Uint32Array(buffer);

    // GLB magic number is 0x46546C67 ('glTF' in ASCII)
    expect(view[0]).toBe(0x46546C67);
    expect(buffer.byteLength).toBeGreaterThan(0);
    model.dispose();
  });

  it('includes canvas texture images in the glTF export', async () => {
    const model = createBusModel();
    // Force a display text change so the canvas texture has content
    setBusDisplayText(model, 'TEST STOP');
    const json = await exportBusModelToGLTF(model);
    const doc = JSON.parse(json);

    expect(doc.images.length).toBeGreaterThan(0);
    const hasEmbeddedDisplay = doc.images.some(
      (img: { uri?: string; bufferView?: number }) => img.uri !== undefined || img.bufferView !== undefined,
    );
    expect(hasEmbeddedDisplay).toBe(true);
    model.dispose();
  });
});

describe('bus doors', () => {
  const leaves = (model: ReturnType<typeof createBusModel>) => [
    model.door.getObjectByName('bus:door-leaf-rear')!,
    model.door.getObjectByName('bus:door-leaf-front')!,
  ];

  it('hangs each leaf on an axle down its own centre, inside the clear opening', () => {
    const model = createBusModel();
    try {
      const [rear, front] = leaves(model);
      // Both axles sit between the door posts, and the front one further forward.
      for (const leaf of [rear, front]) {
        expect(leaf.position.z).toBeGreaterThan(BUS_DOOR_BACK_Z);
        expect(leaf.position.z).toBeLessThan(BUS_DOOR_FRONT_Z);
      }
      expect(front.position.z).toBeGreaterThan(rear.position.z);
      // The leaf itself is centred on its axle — that is what makes it a pivot door
      // rather than a flap hinged along one edge.
      expect(front.children[0].position.z).toBe(0);
    } finally {
      model.dispose();
    }
  });

  it('turns the two leaves opposite ways, so the opening grows from the middle out', () => {
    const model = createBusModel();
    try {
      const [rear, front] = leaves(model);
      setBusDoorOpen(model, 1);
      expect(Math.abs(rear.rotation.y)).toBeCloseTo(Math.abs(BUS_DOOR_OPEN_ANGLE), 6);
      expect(Math.abs(front.rotation.y)).toBeCloseTo(Math.abs(BUS_DOOR_OPEN_ANGLE), 6);
      expect(Math.sign(rear.rotation.y)).toBe(-Math.sign(front.rotation.y));

      setBusDoorOpen(model, 0);
      expect(rear.rotation.y).toBeCloseTo(0, 6);
      expect(front.rotation.y).toBeCloseTo(0, 6);
    } finally {
      model.dispose();
    }
  });

  it('clamps a fraction outside 0..1 rather than over-rotating the leaves', () => {
    const model = createBusModel();
    try {
      const [, front] = leaves(model);
      setBusDoorOpen(model, 4);
      expect(front.rotation.y).toBeCloseTo(BUS_DOOR_OPEN_ANGLE, 6);
      setBusDoorOpen(model, -1);
      expect(front.rotation.y).toBeCloseTo(0, 6);
    } finally {
      model.dispose();
    }
  });
});

describe('bus steering', () => {
  it('puts the steered axle ahead of the driven one, a wheelbase apart', () => {
    expect(BUS_FRONT_AXLE_Z).toBeGreaterThan(BUS_REAR_AXLE_Z);
    expect(BUS_WHEELBASE).toBeCloseTo(BUS_FRONT_AXLE_Z - BUS_REAR_AXLE_Z, 6);
    // Long enough for the tail to off-track noticeably, short enough to leave the
    // overhangs a real bus has at both ends of an 11m body.
    expect(BUS_WHEELBASE).toBeGreaterThan(6);
    expect(BUS_WHEELBASE).toBeLessThan(9);
  });

  it('splits the front wheels into distinct Ackermann angles and turns the driver much further', () => {
    const model = createBusModel();
    try {
      setBusSteer(model, 0.3);
      const expected = computeAckermannAngles(0.3, BUS_WHEELBASE, BUS_HALF_TRACK * 2);
      const [left, right] = model.frontWheels;
      expect(left.rotation.y).toBeCloseTo(expected.left, 6);
      expect(right.rotation.y).toBeCloseTo(expected.right, 6);
      // Turning left, the left (inner) wheel points sharper than the right (outer) one —
      // the defining signature of Ackermann geometry, not parallel steer.
      expect(left.rotation.y).toBeGreaterThan(right.rotation.y);
      // A big wheel on a slow box: the driver's hands move several times as far as the
      // road wheels, and the other way, since the rim faces them.
      const rim = model.steeringWheel.children[0].rotation.z;
      expect(Math.sign(rim)).toBe(-1);
      expect(Math.abs(rim)).toBeGreaterThan(1);
    } finally {
      model.dispose();
    }
  });

  it('holds the commanded angle at full lock rather than winding past it', () => {
    const model = createBusModel();
    try {
      setBusSteer(model, 10);
      const left = computeAckermannAngles(BUS_MAX_STEER, BUS_WHEELBASE, BUS_HALF_TRACK * 2);
      expect(model.frontWheels[0].rotation.y).toBeCloseTo(left.left, 6);
      expect(model.frontWheels[1].rotation.y).toBeCloseTo(left.right, 6);
      setBusSteer(model, -10);
      const right = computeAckermannAngles(-BUS_MAX_STEER, BUS_WHEELBASE, BUS_HALF_TRACK * 2);
      expect(model.frontWheels[0].rotation.y).toBeCloseTo(right.left, 6);
      expect(model.frontWheels[1].rotation.y).toBeCloseTo(right.right, 6);
    } finally {
      model.dispose();
    }
  });

  it('rolls all six wheels together about their own axle, independent of steer lock', () => {
    const model = createBusModel();
    try {
      expect(model.wheelRoll).toHaveLength(6);
      setBusWheelRoll(model, 2.4);
      for (const wheel of model.wheelRoll) expect(wheel.rotation.x).toBeCloseTo(2.4, 6);

      // A front wheel's roll is nested inside its steer group, so locking the wheels
      // over does not itself change how far they have rolled...
      setBusSteer(model, BUS_MAX_STEER);
      for (const wheel of model.wheelRoll) expect(wheel.rotation.x).toBeCloseTo(2.4, 6);
      // ...and rolling further does not reset the lock.
      const locked = computeAckermannAngles(BUS_MAX_STEER, BUS_WHEELBASE, BUS_HALF_TRACK * 2);
      setBusWheelRoll(model, 3.1);
      expect(model.frontWheels[0].rotation.y).toBeCloseTo(locked.left, 6);
      for (const wheel of model.wheelRoll) expect(wheel.rotation.x).toBeCloseTo(3.1, 6);
    } finally {
      model.dispose();
    }
  });
});

describe('bus interior', () => {
  it('lights the saloon and its ceiling panels as night comes in', () => {
    const model = createBusModel();
    try {
      // Never fully out: the roof shades the saloon from the sun, so a bus with its
      // lamps off in the afternoon is a black box inside. See INTERIOR_DAY_FLOOR.
      setBusNightFactor(model, 0);
      const daylight = model.interiorLight.intensity;
      expect(daylight).toBeGreaterThan(0);
      expect(model.interiorPanelMaterial.emissiveIntensity).toBeGreaterThan(0);

      // Interior lighting comes up with dusk rather than waiting for the headlight
      // threshold, which only trips at 0.35.
      setBusNightFactor(model, 0.2);
      expect(model.interiorLight.intensity).toBeGreaterThan(daylight);
      expect(model.headlights[0].intensity).toBe(0);

      setBusNightFactor(model, 1);
      const full = model.interiorLight.intensity;
      expect(full).toBeGreaterThan(0);
      // Dim and warm, not a second pair of headlights pointed at the seats.
      expect(full).toBeLessThan(model.headlights[0].intensity);
    } finally {
      model.dispose();
    }
  });

  it('names the next stop and counts the distance down as the bus covers it', () => {
    const model = createBusModel();
    try {
      setBusNextStop(model, 'Slussen', 1240);
      const far = model.interiorSign.userData.text as string;
      expect(far).toContain('Slussen');
      expect(far).toContain('1.2 km');

      setBusNextStop(model, 'Slussen', 240);
      expect(model.interiorSign.userData.text).toContain('240 m');

      // Rounded to 10m so a bus at 14 m/s does not turn the sign into a flickering
      // odometer.
      setBusNextStop(model, 'Slussen', 236);
      expect(model.interiorSign.userData.text).toContain('240 m');
    } finally {
      model.dispose();
    }
  });

  it('names the stop without a distance before the ride has one', () => {
    const model = createBusModel();
    try {
      setBusNextStop(model, 'Slussen', null);
      expect(model.interiorSign.userData.text).toContain('Slussen');
      expect(model.interiorSign.userData.text).not.toMatch(/\d\s*(m|km)/);
    } finally {
      model.dispose();
    }
  });

  it('keeps the saloon dim enough that the world outside stays the brighter thing', () => {
    const model = createBusModel();
    try {
      setBusNightFactor(model, 1);
      // The ceiling panels are unlit emissive surfaces; over 1 they blow out to flat
      // white and take the windows with them.
      expect(model.interiorPanelMaterial.emissiveIntensity).toBeLessThan(0.5);
      // Well under the sun's own daytime intensity (3.2), so the fill reads as a lamp
      // rather than as a second key light on the seats.
      expect(model.interiorLight.intensity).toBeLessThanOrEqual(2);
    } finally {
      model.dispose();
    }
  });
});

describe('bus proximity strip', () => {
  const entry = (name: string, distance: number, direction: string) => ({ name, distance, direction });

  it('runs the nearest places with a bearing arrow and a distance', () => {
    const model = createBusModel();
    try {
      setBusProximity(model, [entry('Skansen', 180, 'ahead'), entry('Vasamuseet', 1420, 'left')]);
      const line = model.proximitySign.userData.text as string;
      expect(line).toContain('SKANSEN');
      expect(line).toContain('180m');
      expect(line).toContain('↑');
      expect(line).toContain('VASAMUSEET');
      expect(line).toContain('1.4km');
      expect(line).toContain('←');
    } finally {
      model.dispose();
    }
  });

  it('shows only as many places as stay readable at a glance', () => {
    const model = createBusModel();
    try {
      setBusProximity(model, [
        entry('Alpha', 10, 'ahead'),
        entry('Beta', 20, 'ahead'),
        entry('Gamma', 30, 'ahead'),
      ]);
      expect(model.proximitySign.userData.text).not.toContain('GAMMA');
    } finally {
      model.dispose();
    }
  });

  it('truncates a long name rather than pushing its distance off the strip', () => {
    const model = createBusModel();
    try {
      setBusProximity(model, [entry('Kungliga Djurgardens Museum', 240, 'right')]);
      const line = model.proximitySign.userData.text as string;
      expect(line).toContain('240m');
      expect(line).not.toContain('MUSEUM');
    } finally {
      model.dispose();
    }
  });

  it('says nothing rather than nonsense when there is nothing nearby', () => {
    const model = createBusModel();
    try {
      setBusProximity(model, []);
      expect(model.proximitySign.userData.text).toBe('· · ·');
    } finally {
      model.dispose();
    }
  });
});

describe('bus signage faces the people it is for', () => {
  /** The seats run down negative z (BUS_SEAT_OFFSET.z is -4.35), the windscreen is at
   * +z. A sign's plane faces its own +z, so a yaw of PI is what turns it to the saloon. */
  const facesSaloon = (mesh: THREE.Object3D) => Math.abs(Math.abs(mesh.rotation.y) - Math.PI) < 1e-6;

  it('turns the next-stop sign and the proximity strip back down the saloon', () => {
    const model = createBusModel();

    expect(facesSaloon(model.interiorSign)).toBe(true);
    expect(facesSaloon(model.proximitySign)).toBe(true);
    // In front of the seats, so a seated passenger is looking at them.
    expect(model.interiorSign.position.z).toBeGreaterThan(0);
    expect(model.proximitySign.position.z).toBeGreaterThan(0);
    // The strip sits under the sign, where a real vehicle puts its running info line.
    expect(model.proximitySign.position.y).toBeLessThan(model.interiorSign.position.y);
    model.dispose();
  });

  it('puts the destination blind outside the windscreen facing the street', () => {
    const model = createBusModel();

    // Read by people waiting at a stop, so it must not face into the saloon.
    expect(facesSaloon(model.display)).toBe(false);
    expect(model.display.rotation.y).toBe(0);
    // Proud of the front glass, which sits at z 5.45.
    expect(model.display.position.z).toBeGreaterThan(5.45);
    model.dispose();
  });
});

describe('clampToBusFloor', () => {
  it('leaves a point already inside the floor untouched', () => {
    expect(clampToBusFloor(0.3, -1.2)).toEqual({ x: 0.3, z: -1.2 });
  });

  it('clamps x to the aisle half-width, narrower than the full interior', () => {
    expect(clampToBusFloor(BUS_INTERIOR_HALF_WIDTH + 5, 0)).toEqual({ x: BUS_AISLE_HALF_WIDTH, z: 0 });
    expect(clampToBusFloor(-BUS_INTERIOR_HALF_WIDTH - 5, 0)).toEqual({ x: -BUS_AISLE_HALF_WIDTH, z: 0 });
    expect(BUS_AISLE_HALF_WIDTH).toBeLessThan(BUS_INTERIOR_HALF_WIDTH);
  });

  it('clamps z to the interior half-length', () => {
    expect(clampToBusFloor(0, BUS_INTERIOR_HALF_LENGTH + 5)).toEqual({ x: 0, z: BUS_INTERIOR_HALF_LENGTH });
    expect(clampToBusFloor(0, -BUS_INTERIOR_HALF_LENGTH - 5)).toEqual({ x: 0, z: -BUS_INTERIOR_HALF_LENGTH });
  });

  it('clamps both axes independently at once', () => {
    const result = clampToBusFloor(BUS_INTERIOR_HALF_WIDTH + 1, -BUS_INTERIOR_HALF_LENGTH - 1);
    expect(result).toEqual({ x: BUS_AISLE_HALF_WIDTH, z: -BUS_INTERIOR_HALF_LENGTH });
  });
});

describe('resolveAgainstBusSeats', () => {
  it('leaves a point in the aisle, clear of every seat box, untouched', () => {
    expect(BUS_SEAT_COLLIDERS.length).toBeGreaterThan(0);
    const result = resolveAgainstBusSeats(0, 0, 0.3);
    expect(result).toEqual({ x: 0, z: 0 });
  });

  it('pushes a point out of the seat box it overlaps', () => {
    const seat = BUS_SEAT_COLLIDERS[0];
    const centerX = (seat.minX + seat.maxX) / 2;
    const centerZ = (seat.minZ + seat.maxZ) / 2;
    const result = resolveAgainstBusSeats(centerX, centerZ, 0.3);
    // No longer inside the box it was pushed out of.
    expect(result.x < seat.minX || result.x > seat.maxX || result.z < seat.minZ || result.z > seat.maxZ).toBe(true);
  });
});

describe('computeRiderWorldPosition', () => {
  it('adds an unrotated local offset straight onto the bus position when the bus faces forward', () => {
    const result = computeRiderWorldPosition({ x: 10, z: 20 }, 0, { x: 1, z: 2 });
    expect(result.x).toBeCloseTo(11);
    expect(result.z).toBeCloseTo(22);
  });

  it('rotates the local offset by the bus heading before adding it', () => {
    // A quarter turn (pi/2) swings a rider standing to the bus's local +x side (its
    // left) around to sit behind the bus in world +z, the same way a real seat fixed
    // to the chassis follows the chassis when it turns.
    const result = computeRiderWorldPosition({ x: 0, z: 0 }, Math.PI / 2, { x: 1, z: 0 });
    expect(result.x).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(-1);
  });

  it('tracks the bus body as it moves, which is the whole point: this must run every tick the bus is occupied, including while driving or braking', () => {
    // This is the regression this test exists for: computeRiderWorldPosition captures
    // the "position = bus position + rotated local offset" math that must run on
    // every occupied tick (see the `if (riding)`, not `else if`, comment at its call
    // site in svartaksiRuntime.tsx). If that were ever chained back onto `else if
    // (riding)` after `if (traveling)`, the rider's position would freeze while the
    // bus is actually driving or braking even though this function itself still
    // computes correctly — so this test pins the pure math a caller-side regression
    // would silently stop invoking.
    const busAtStop = { x: 0, z: 0 };
    const busMidRoute = { x: 50, z: 30 };
    const offset = { x: 0.5, z: -1 };

    const atStop = computeRiderWorldPosition(busAtStop, 0, offset);
    const midRoute = computeRiderWorldPosition(busMidRoute, 0, offset);

    expect(midRoute.x - atStop.x).toBeCloseTo(busMidRoute.x - busAtStop.x);
    expect(midRoute.z - atStop.z).toBeCloseTo(busMidRoute.z - busAtStop.z);
  });
});
