import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  accessSide,
  advanceVehicleTransition,
  beginVehicleEntry,
  beginVehicleExit,
  shortestAngle,
  sideAccessPoint,
  yawTowards,
  type VehicleAccessPoint,
  type VehicleTransitionPhase,
  type VehicleTransitionPose,
} from '@/svartaksi/vehicleEntry';
import { VEHICLE_ACCESS } from '@/svartaksi/gameplayConfig';

const ACCESS: VehicleAccessPoint = {
  entry: new THREE.Vector3(1.54, 0, 0.35),
  seat: new THREE.Vector3(0.38, 0.62, 0.35),
  seatYaw: 0,
  side: 1,
};

const STEP = 1 / 60;

/** Runs the sequence to completion, at a fixed step, collecting every pose. */
function runToEnd(
  transition: ReturnType<typeof beginVehicleEntry>,
  wantsToMove = false,
  maxSeconds = 10,
): VehicleTransitionPose[] {
  const poses: VehicleTransitionPose[] = [];
  for (let t = 0; t < maxSeconds; t += STEP) {
    const pose = advanceVehicleTransition(transition, STEP, { wantsToMove });
    poses.push(pose);
    if (pose.finished) break;
  }
  return poses;
}

describe('accessSide', () => {
  it('reads the door as being on the side the entry point is offset to', () => {
    expect(accessSide(new THREE.Vector3(1.5, 0, 0), new THREE.Vector3(0.4, 0, 0))).toBe(1);
    expect(accessSide(new THREE.Vector3(-1.5, 0, 0), new THREE.Vector3(-0.4, 0, 0))).toBe(-1);
  });
});

describe('getting in', () => {
  it('walks to the door, then sits, and ends in the seat', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    const poses = runToEnd(transition);
    const phases: VehicleTransitionPhase[] = [];
    for (const pose of poses) if (phases.at(-1) !== pose.phase) phases.push(pose.phase);

    expect(phases).toEqual(['opening', 'entering', 'seated']);
    const last = poses.at(-1)!;
    expect(last.finished).toBe(true);
    expect(last.position.distanceTo(ACCESS.seat)).toBeLessThan(0.02);
    expect(last.yaw).toBeCloseTo(ACCESS.seatYaw, 2);
  });

  it('takes about as long as the two animations it was ported from', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    const poses = runToEnd(transition);
    const seconds = poses.length * STEP;

    const expected = VEHICLE_ACCESS.openDoorSeconds + VEHICLE_ACCESS.sitDownSeconds;
    expect(seconds).toBeGreaterThan(expected - 0.1);
    expect(seconds).toBeLessThan(expected + 0.1);
  });

  it('passes through the door on the way to the seat rather than through the body', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    const poses = runToEnd(transition);
    const atDoor = poses.find((pose) => pose.phase === 'entering');

    expect(atDoor).toBeDefined();
    // The first frame of `entering` starts from the entry point: the body reached the
    // door before it started to sit, which is the whole reason this is two phases.
    expect(atDoor!.position.distanceTo(ACCESS.entry)).toBeLessThan(0.1);
  });

  it('opens the door after the reach, and has it fully open before anyone climbs in', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    const poses = runToEnd(transition);

    expect(poses[0].doorOpen).toBe(0);
    const firstMoving = poses.findIndex((pose) => pose.doorOpen > 0);
    expect(firstMoving * STEP).toBeGreaterThanOrEqual(VEHICLE_ACCESS.doorReachSeconds - STEP);

    const entering = poses.filter((pose) => pose.phase === 'entering');
    expect(entering.every((pose) => pose.doorOpen === 1)).toBe(true);
  });

  it('is pulled shut again once the driver is in the seat', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    const poses = runToEnd(transition);

    expect(poses.at(-1)!.doorOpen).toBe(0);
  });

  it('lets the player change their mind while the door is still opening', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    const poses = runToEnd(transition, true);
    const last = poses.at(-1)!;

    expect(last.phase).toBe('afoot');
    // Left standing at the door, not snapped back to where they started and not in the car.
    expect(last.position.distanceTo(ACCESS.entry)).toBeLessThan(0.02);
  });

  it('ignores a change of mind once the body is already folding into the seat', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    // Walk the door phase out with no input, then hold a direction for the rest.
    for (let t = 0; t < VEHICLE_ACCESS.openDoorSeconds + STEP; t += STEP) {
      advanceVehicleTransition(transition, STEP, { wantsToMove: false });
    }
    expect(transition.phase).toBe('entering');

    const poses = runToEnd(transition, true);
    expect(poses.at(-1)!.phase).toBe('seated');
  });

  it('keeps reporting the final pose if it is advanced past the end', () => {
    const transition = beginVehicleEntry(ACCESS, new THREE.Vector3(2.6, 0, -1.4), 0);
    runToEnd(transition);

    const extra = advanceVehicleTransition(transition, STEP);
    expect(extra.phase).toBe('seated');
    expect(extra.finished).toBe(true);
    expect(extra.position.distanceTo(ACCESS.seat)).toBeLessThan(0.02);
  });
});

describe('getting out', () => {
  it('rises out of the seat, closes the door, and ends on the road', () => {
    const transition = beginVehicleExit(ACCESS, 0);
    const poses = runToEnd(transition);
    const phases: VehicleTransitionPhase[] = [];
    for (const pose of poses) if (phases.at(-1) !== pose.phase) phases.push(pose.phase);

    expect(phases).toEqual(['exiting', 'closing', 'afoot']);
    const last = poses.at(-1)!;
    expect(last.position.distanceTo(ACCESS.entry)).toBeLessThan(0.02);
    expect(last.doorOpen).toBe(0);
  });

  it('starts with the door already open — nobody climbs out of a shut one', () => {
    const transition = beginVehicleExit(ACCESS, 0);
    const poses = runToEnd(transition);

    expect(poses[0].doorOpen).toBe(1);
    const closing = poses.filter((pose) => pose.phase === 'closing');
    expect(closing[0].doorOpen).toBeGreaterThan(closing.at(-1)!.doorOpen);
  });

  it('faces the body out of the car as it leaves the seat', () => {
    const transition = beginVehicleExit(ACCESS, 0);
    const poses = runToEnd(transition);

    // The entry point is to the car's left of the seat, so the body turns to face +x.
    expect(poses.at(-1)!.yaw).toBeCloseTo(Math.PI / 2, 1);
  });

  it('records stepping out of a moving car as a stumble, and out of a parked one as not', () => {
    expect(beginVehicleExit(ACCESS, 0).stumbled).toBe(false);
    expect(beginVehicleExit(ACCESS, VEHICLE_ACCESS.stumbleSpeed + 0.5).stumbled).toBe(true);
    // Reversing out of a parking space counts the same as rolling forward out of one.
    expect(beginVehicleExit(ACCESS, -(VEHICLE_ACCESS.stumbleSpeed + 0.5)).stumbled).toBe(true);
  });
});

describe('angles', () => {
  it('turns the short way round', () => {
    expect(shortestAngle(0, Math.PI * 1.9)).toBeCloseTo(-Math.PI * 0.1, 5);
    expect(shortestAngle(Math.PI * 1.9, 0)).toBeCloseTo(Math.PI * 0.1, 5);
  });

  it('points at a target, and keeps the old heading when there is nowhere to point', () => {
    const here = new THREE.Vector3(0, 0, 0);
    expect(yawTowards(here, new THREE.Vector3(0, 0, 1), 9)).toBeCloseTo(0, 5);
    expect(yawTowards(here, new THREE.Vector3(1, 0, 0), 9)).toBeCloseTo(Math.PI / 2, 5);
    expect(yawTowards(here, here, 9)).toBe(9);
  });

  it('never swings the long way while turning to the seat', () => {
    const facingAway: VehicleAccessPoint = { ...ACCESS, seatYaw: Math.PI * 1.95 };
    const transition = beginVehicleEntry(facingAway, new THREE.Vector3(2.6, 0, -1.4), 0);
    const yaws = runToEnd(transition).map((pose) => pose.yaw);

    for (let i = 1; i < yaws.length; i += 1) {
      expect(Math.abs(yaws[i] - yaws[i - 1])).toBeLessThan(0.6);
    }
  });
});

describe('sideAccessPoint', () => {
  it('stands the entry point a step outboard of the flank, level with the seat', () => {
    const seat = new THREE.Vector3(0.38, 0.62, 0.35);
    const access = sideAccessPoint(seat, 0.99, 1);

    expect(access.entry.x).toBeCloseTo(0.99 + VEHICLE_ACCESS.doorStandOffset);
    expect(access.entry.z).toBeCloseTo(seat.z);
    expect(access.entry.y).toBe(0);
    expect(access.side).toBe(1);
  });
});
