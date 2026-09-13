import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  FRAMED_WHEEL_LOCAL,
  INTRO_DURATION,
  INTRO_HOUR,
  INTRO_SHOTS,
  INTRO_START_SPEED,
  busIsOffCamera,
  busLocalToWorld,
  introShotAt,
  introShotStart,
  projectToNdc,
  resolveIntroShot,
  type BusPose,
} from '../../src/svartaksi/introSequence';
import { INTRO_ROAD_PATH } from '../../src/svartaksi/introStage';
import {
  BUS_SPEED,
  advanceRideSpeed,
  buildRideProfile,
  profileSpeedLimit,
  sampleRide,
} from '../../src/svartaksi/busRouting';
import { sceneLighting } from '../../src/world/timeOfDay';

/** The two display shapes the framing has to survive: the common one, and the widest
 * ultrawide in ordinary use — which is the hostile case, since a wider frame sees more
 * road and therefore gives scene 1 less empty-road padding at each end. */
const WIDE = 16 / 9;
const ULTRAWIDE = 21 / 9;

/**
 * Replays the ride the way the frame loop will: seeded at INTRO_START_SPEED rather than
 * from rest, integrated against the same profile speed limit. Returns the bus's pose at
 * each requested time, so a framing assertion is made against where the bus *actually* is
 * and not against an assumed constant velocity.
 */
function drive(times: number[]): Map<number, BusPose> {
  const profile = buildRideProfile(INTRO_ROAD_PATH);
  const wanted = [...times].sort((a, b) => a - b);
  const poses = new Map<number, BusPose>();
  const dt = 1 / 120;
  let speed = INTRO_START_SPEED;
  let traveled = 0;
  let next = 0;
  for (let t = 0; next < wanted.length; t += dt) {
    while (next < wanted.length && t >= wanted[next]) {
      const sample = sampleRide(INTRO_ROAD_PATH, traveled);
      poses.set(wanted[next], {
        position: new THREE.Vector3(sample.point.x, 0, sample.point.z),
        heading: sample.heading,
      });
      next += 1;
    }
    speed = advanceRideSpeed(speed, profileSpeedLimit(profile, traveled), dt);
    traveled += speed * dt;
  }
  return poses;
}

describe('the intro road and the shot table agree', () => {
  it('gives the bus a route it can actually drive', () => {
    const profile = buildRideProfile(INTRO_ROAD_PATH);
    // Not a diagnostic here but a hard requirement: an infeasible corner means the bus
    // visibly clips the bend, in a shot whose whole subject is the bus taking bends.
    expect(profile.infeasible).toEqual([]);
  });

  it('holds road speed through scene 1, so the bus crosses frame at a constant rate', () => {
    const scene2 = introShotStart('scene2-follow');
    const profile = buildRideProfile(INTRO_ROAD_PATH);
    let speed = INTRO_START_SPEED;
    let traveled = 0;
    const dt = 1 / 120;
    for (let t = 0; t < scene2; t += dt) {
      speed = advanceRideSpeed(speed, profileSpeedLimit(profile, traveled), dt);
      traveled += speed * dt;
      expect(speed).toBeCloseTo(BUS_SPEED, 2);
    }
  });

  it('eases off for the weave during scene 2 without crawling', () => {
    const poses = drive([introShotStart('scene2-follow') + 6]);
    const mid = poses.get(introShotStart('scene2-follow') + 6)!;
    // Mid-weave the road is turned well off its axis — this is what "snaking" has to mean
    // geometrically for the follow shot to have anything to follow.
    const offAxis = Math.abs(mid.heading - -Math.PI / 2);
    expect(offAxis).toBeGreaterThan(0.25);
  });

  it('is still running out at full speed when scene 3 ends, not braking to a stop', () => {
    const profile = buildRideProfile(INTRO_ROAD_PATH);
    let speed = INTRO_START_SPEED;
    let traveled = 0;
    const dt = 1 / 120;
    for (let t = 0; t < INTRO_DURATION; t += dt) {
      speed = advanceRideSpeed(speed, profileSpeedLimit(profile, traveled), dt);
      traveled += speed * dt;
    }
    expect(speed).toBeCloseTo(BUS_SPEED, 1);
    // And with road left over, so scene 3 can hold on the wheel while a slow world load
    // finishes rather than running the bus off the end of its own route.
    expect(profile.length - traveled).toBeGreaterThan(100);
  });
});

describe('scene 1 — the locked-off tripod', () => {
  const shot = INTRO_SHOTS[0];
  const placement = resolveIntroShot(shot, 0, {
    position: new THREE.Vector3(),
    heading: 0,
  });

  it('does not move, whatever the bus does', () => {
    const early = resolveIntroShot(shot, 0, { position: new THREE.Vector3(2_230, 0, 2_000), heading: -Math.PI / 2 });
    const late = resolveIntroShot(shot, 7, { position: new THREE.Vector3(2_130, 0, 2_000), heading: -Math.PI / 2 });
    expect(early.position.distanceTo(late.position)).toBe(0);
    expect(early.lookAt.distanceTo(late.lookAt)).toBe(0);
  });

  it('carries the bus from the right of frame to the left', () => {
    const samples = [2, 3, 4, 5, 6];
    const poses = drive(samples);
    const xs = samples.map((t) => projectToNdc(placement, WIDE, poses.get(t)!.position).x);
    // Strictly decreasing: enters right (positive x), leaves left (negative x).
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeLessThan(xs[i - 1]);
    expect(xs[0]).toBeGreaterThan(0);
    expect(xs[xs.length - 1]).toBeLessThan(0);
  });

  it('opens and closes on empty road', () => {
    for (const aspect of [WIDE, ULTRAWIDE]) {
      const poses = drive([0, 1, shot.seconds - 1, shot.seconds]);
      // The padding the scene asks for: a full second of empty frame at each end, on the
      // widest display as well as the common one.
      expect(busIsOffCamera(placement, aspect, poses.get(0)!)).toBe(true);
      expect(busIsOffCamera(placement, aspect, poses.get(1)!)).toBe(true);
      expect(busIsOffCamera(placement, aspect, poses.get(shot.seconds - 1)!)).toBe(true);
      expect(busIsOffCamera(placement, aspect, poses.get(shot.seconds)!)).toBe(true);
    }
  });

  it('has the bus fully in frame in the middle of the shot', () => {
    const poses = drive([4]);
    expect(busIsOffCamera(placement, WIDE, poses.get(4)!)).toBe(false);
  });

  it('lights the bus: late evening is past the headlight threshold', () => {
    // setBusNightFactor switches the headlights on above 0.35 and leaves them dark below
    // it, so "strong headlights" is a property of this hour, not of the wish for them.
    expect(sceneLighting(INTRO_HOUR).nightFactor).toBeGreaterThan(0.35);
  });
});

describe('scene 2 — the follow', () => {
  const shot = INTRO_SHOTS[1];

  it('keeps the bus in frame across the whole weave', () => {
    const start = introShotStart('scene2-follow');
    const poses = drive([0, 2, 5, 8, 11, 14, 15.9].map((t) => start + t));
    for (const [time, pose] of poses) {
      const placement = resolveIntroShot(shot, time - start, pose);
      const ndc = projectToNdc(placement, WIDE, pose.position);
      expect(ndc.ahead).toBe(true);
      expect(Math.abs(ndc.x)).toBeLessThan(0.5);
      expect(Math.abs(ndc.y)).toBeLessThan(0.5);
    }
  });

  it('crosses from one side of the bus to the other as the shot runs', () => {
    const pose: BusPose = { position: new THREE.Vector3(0, 0, 0), heading: 0 };
    const opening = resolveIntroShot(shot, 0, pose);
    const closing = resolveIntroShot(shot, shot.seconds, pose);
    // With the bus heading +z, its left is +x. The camera starts to the left and ends to
    // the right, which is what puts it outside each bend in turn.
    expect(opening.position.x).toBeGreaterThan(1);
    expect(closing.position.x).toBeLessThan(-1);
    // And rises as it goes.
    expect(closing.position.y).toBeGreaterThan(opening.position.y);
  });

  it('stays behind the bus throughout', () => {
    const pose: BusPose = { position: new THREE.Vector3(0, 0, 0), heading: 0 };
    for (let t = 0; t <= shot.seconds; t += 1) {
      // Heading +z means behind is −z.
      expect(resolveIntroShot(shot, t, pose).position.z).toBeLessThan(0);
    }
  });
});

describe('scene 3 — the wheel, bolted to the bus', () => {
  const shot = INTRO_SHOTS[2];

  it('puts the front wheel in the right of the frame', () => {
    const pose: BusPose = { position: new THREE.Vector3(0, 0, 0), heading: 0 };
    const placement = resolveIntroShot(shot, 0, pose);
    const wheel = busLocalToWorld(pose, FRAMED_WHEEL_LOCAL);
    const ndc = projectToNdc(placement, WIDE, wheel);
    expect(ndc.ahead).toBe(true);
    // Right of centre and inside the frame: the subject of the shot, not an edge artefact.
    expect(ndc.x).toBeGreaterThan(0.1);
    expect(ndc.x).toBeLessThan(1);
    expect(Math.abs(ndc.y)).toBeLessThan(1);
  });

  it('points forward, along the bus rather than across it', () => {
    const pose: BusPose = { position: new THREE.Vector3(0, 0, 0), heading: 0 };
    const placement = resolveIntroShot(shot, 0, pose);
    const aim = new THREE.Vector3().subVectors(placement.lookAt, placement.position).normalize();
    // Overwhelmingly the bus's forward axis (+z at heading 0).
    expect(aim.z).toBeGreaterThan(0.95);
  });

  it('holds the same pose in the bus frame however the bus is placed and turned', () => {
    const a: BusPose = { position: new THREE.Vector3(0, 0, 0), heading: 0 };
    const b: BusPose = { position: new THREE.Vector3(2_000, 0, -450), heading: 2.1 };
    const wheelA = busLocalToWorld(a, FRAMED_WHEEL_LOCAL);
    const wheelB = busLocalToWorld(b, FRAMED_WHEEL_LOCAL);
    const ndcA = projectToNdc(resolveIntroShot(shot, 0, a), WIDE, wheelA);
    const ndcB = projectToNdc(resolveIntroShot(shot, 3, b), WIDE, wheelB);
    // A rigidly bolted rig frames its subject identically wherever the vehicle is: this is
    // what makes the shot safe to swap the world underneath.
    expect(ndcB.x).toBeCloseTo(ndcA.x, 6);
    expect(ndcB.y).toBeCloseTo(ndcA.y, 6);
  });

  it('sits outside the bodywork rather than inside the saloon', () => {
    expect(Math.abs(shot.kind === 'bolted' ? shot.offset.x : 0)).toBeGreaterThan(1.3);
  });
});

describe('shot scheduling', () => {
  it('runs the three scenes in order and then ends', () => {
    expect(introShotAt(0)!.shot.id).toBe('scene1-tripod');
    expect(introShotAt(INTRO_DURATION - 0.01)!.shot.id).toBe('scene3-wheel');
    expect(introShotAt(INTRO_DURATION)).toBeNull();
  });

  it('reports time within the current shot, not since the beginning', () => {
    const start = introShotStart('scene2-follow');
    const at = introShotAt(start + 2.5)!;
    expect(at.shot.id).toBe('scene2-follow');
    expect(at.local).toBeCloseTo(2.5, 6);
  });

  it('names a start for every shot in the table', () => {
    for (const shot of INTRO_SHOTS) expect(Number.isFinite(introShotStart(shot.id))).toBe(true);
  });
});
