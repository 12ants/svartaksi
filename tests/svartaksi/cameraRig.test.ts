import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyCameraSettings, clampPlacementAboveGround, pullPlacementClearOfObstruction,
  FOOT_RIG, INTERIOR_RIG, resolveCameraPlacement, VEHICLE_RIG,
} from '../../src/svartaksi/cameraRig';
import {
  CAMERA_SETTING_BOUNDS, DEFAULT_CAMERA_SETTINGS, type CameraSettings,
} from '../../src/svartaksi/cameraSettings';
import { BUS_INTERIOR_HALF_LENGTH } from '../../src/svartaksi/busModel';
import type { CameraMode } from '../../src/svartaksi/cameraModes';

/** Facing due north in this renderer's convention: forward = (sin h, 0, cos h). */
const NORTH = 0;
const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('resolveCameraPlacement', () => {
  it('puts the chase camera behind and above whatever it follows', () => {
    const { position, lookAt } = resolveCameraPlacement('chase', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);

    expect(position.z).toBeCloseTo(-VEHICLE_RIG.chaseBack, 6);
    expect(position.y).toBeCloseTo(VEHICLE_RIG.chaseUp, 6);
    expect(lookAt.y).toBeCloseTo(VEHICLE_RIG.targetUp, 6);
    expect(lookAt.z).toBeCloseTo(0, 6);
  });

  it('follows the body rather than the world origin', () => {
    const { position, lookAt } = resolveCameraPlacement('chase', VEHICLE_RIG, at(120, 0, -80), NORTH, 0);

    expect(position.x).toBeCloseTo(120, 6);
    expect(position.z).toBeCloseTo(-80 - VEHICLE_RIG.chaseBack, 6);
    expect(lookAt.x).toBeCloseTo(120, 6);
  });

  it('swings with the heading, staying behind a body facing east', () => {
    const east = Math.PI / 2;
    const { position } = resolveCameraPlacement('chase', VEHICLE_RIG, at(0, 0, 0), east, 0);

    expect(position.x).toBeCloseTo(-VEHICLE_RIG.chaseBack, 6);
    expect(position.z).toBeCloseTo(0, 6);
  });

  it('aims the first-person modes far down the road, not at the bonnet', () => {
    for (const mode of ['hood', 'cockpit'] as const) {
      const { position, lookAt } = resolveCameraPlacement(mode, VEHICLE_RIG, at(0, 0, 0), NORTH, 0);
      expect(lookAt.z).toBeGreaterThan(20);
      expect(lookAt.distanceTo(position)).toBeGreaterThan(20);
    }
  });

  it('keeps top-down slightly off the vertical, so the horizon cannot flip', () => {
    const { position, lookAt } = resolveCameraPlacement('top-down', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);

    expect(position.y).toBeCloseTo(VEHICLE_RIG.topDownUp, 6);
    // Straight down would leave the look-at matrix undefined; this is the nudge.
    expect(position.z).not.toBe(lookAt.z);
    expect(Math.abs(position.z - lookAt.z)).toBeLessThan(0.1);
  });

  it('starts the orbit directly behind the body, wherever the body is pointing', () => {
    // Entering orbit used to place the camera at whatever bearing the world clock had
    // reached, so the shot swung round to a random side before it began orbiting. At
    // `timeMs` 0 — the moment orbit is entered — it now stands where chase left it.
    for (const heading of [0, Math.PI / 2, -2.4, 3.1]) {
      const { position } = resolveCameraPlacement('orbit', VEHICLE_RIG, at(0, 0, 0), heading, 0);
      const behind = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading))
        .multiplyScalar(VEHICLE_RIG.orbitRadius);
      expect(position.x).toBeCloseTo(behind.x, 6);
      expect(position.z).toBeCloseTo(behind.z, 6);
    }
  });

  it('moves the orbit camera over time while holding its radius and height', () => {
    const early = resolveCameraPlacement('orbit', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);
    const later = resolveCameraPlacement('orbit', VEHICLE_RIG, at(0, 0, 0), NORTH, 8_000);

    expect(early.position.distanceTo(later.position)).toBeGreaterThan(1);
    for (const { position } of [early, later]) {
      expect(Math.hypot(position.x, position.z)).toBeCloseTo(VEHICLE_RIG.orbitRadius, 6);
      expect(position.y).toBeCloseTo(VEHICLE_RIG.orbitUp, 6);
    }
  });

  it('offsets the cinematic camera to one flank, behind and above', () => {
    const { position } = resolveCameraPlacement('cinematic', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);

    expect(position.z).toBeCloseTo(-VEHICLE_RIG.cinematicBack, 6);
    expect(Math.abs(position.x)).toBeCloseTo(VEHICLE_RIG.cinematicSide, 6);
    expect(position.y).toBeCloseTo(VEHICLE_RIG.cinematicUp, 6);
  });

  it('frames a 1.7m pill closer than a 4.25m car in every mode', () => {
    const modes: CameraMode[] = ['chase', 'hood', 'cockpit', 'top-down', 'orbit', 'cinematic'];
    for (const mode of modes) {
      const vehicle = resolveCameraPlacement(mode, VEHICLE_RIG, at(0, 0, 0), NORTH, 0);
      const foot = resolveCameraPlacement(mode, FOOT_RIG, at(0, 0, 0), NORTH, 0);
      expect(foot.position.length()).toBeLessThanOrEqual(vehicle.position.length());
    }
  });

  it('returns fresh vectors each call, since callers ease toward them', () => {
    const first = resolveCameraPlacement('chase', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);
    const second = resolveCameraPlacement('chase', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);

    expect(first.position).not.toBe(second.position);
    expect(first.lookAt).not.toBe(second.lookAt);
    first.position.set(999, 999, 999);
    expect(second.position.length()).toBeLessThan(100);
  });
});

import { OPENING_CAM_INTRO_DURATION_MS, resolveOpeningIntroPlacement } from '../../src/svartaksi/cameraRig';

describe('resolveOpeningIntroPlacement', () => {
  it('starts at the selectable top-down placement', () => {
    const placement = resolveOpeningIntroPlacement(at(0, 0, 0), NORTH, 0)!;
    const topDown = resolveCameraPlacement('top-down', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);
    expect(placement.position.distanceTo(topDown.position)).toBeCloseTo(0, 6);
    expect(placement.lookAt.distanceTo(topDown.lookAt)).toBeCloseTo(0, 6);
  });

  it('returns null once the intro duration has elapsed', () => {
    expect(resolveOpeningIntroPlacement(at(0, 0, 0), NORTH, OPENING_CAM_INTRO_DURATION_MS)).toBeNull();
    expect(resolveOpeningIntroPlacement(at(0, 0, 0), NORTH, OPENING_CAM_INTRO_DURATION_MS + 500)).toBeNull();
  });

  it('moves slowly and continuously toward the cinematic placement', () => {
    const early = resolveOpeningIntroPlacement(at(0, 0, 0), NORTH, 1_000)!;
    const middle = resolveOpeningIntroPlacement(at(0, 0, 0), NORTH, OPENING_CAM_INTRO_DURATION_MS / 2)!;
    const late = resolveOpeningIntroPlacement(at(0, 0, 0), NORTH, OPENING_CAM_INTRO_DURATION_MS - 1)!;
    const cinematic = resolveCameraPlacement('cinematic', VEHICLE_RIG, at(0, 0, 0), NORTH, 0);
    expect(early.position.y).toBeGreaterThan(middle.position.y);
    expect(middle.position.y).toBeGreaterThan(late.position.y);
    expect(late.position.distanceTo(cinematic.position)).toBeLessThan(0.01);
  });

  it('always looks at the bus position, following it rather than the origin', () => {
    const { lookAt } = resolveOpeningIntroPlacement(at(50, 0, -30), NORTH, 200)!;
    expect(lookAt.x).toBeCloseTo(50, 6);
    expect(lookAt.z).toBeCloseTo(-30, 6);
  });
});

describe('INTERIOR_RIG', () => {
  it('frames the pill closer than the on-foot rig, to fit inside the bus cabin', () => {
    expect(INTERIOR_RIG.chaseBack).toBeLessThan(FOOT_RIG.chaseBack);
    expect(INTERIOR_RIG.chaseUp).toBeLessThan(FOOT_RIG.chaseUp);
  });

  it('never places the chase camera beyond the interior floor bounds', () => {
    expect(INTERIOR_RIG.chaseBack).toBeLessThan(BUS_INTERIOR_HALF_LENGTH);
    expect(INTERIOR_RIG.chaseUp).toBeLessThan(3); // below the roof line
  });
});

const settings = (patch: Partial<CameraSettings> = {}): CameraSettings =>
  ({ ...DEFAULT_CAMERA_SETTINGS, ...patch });

describe('applyCameraSettings', () => {
  it('is the identity on framing at the defaults, so the dials start where the rigs were tuned', () => {
    const applied = applyCameraSettings(VEHICLE_RIG, DEFAULT_CAMERA_SETTINGS);
    for (const key of ['chaseBack', 'chaseUp', 'orbitRadius', 'orbitUp', 'topDownUp',
      'cinematicBack', 'cinematicSide', 'cinematicUp'] as const) {
      expect(applied[key]).toBeCloseTo(VEHICLE_RIG[key], 6);
    }
  });

  it('scales every framing mode with distance but never the first-person eye positions', () => {
    const far = applyCameraSettings(VEHICLE_RIG, settings({ distance: 2 }));
    expect(far.chaseBack).toBeCloseTo(VEHICLE_RIG.chaseBack * 2, 6);
    expect(far.orbitRadius).toBeCloseTo(VEHICLE_RIG.orbitRadius * 2, 6);
    expect(far.topDownUp).toBeCloseTo(VEHICLE_RIG.topDownUp * 2, 6);
    // The driver's head does not move: scaling these would put it through the windscreen.
    expect(far.hoodForward).toBe(VEHICLE_RIG.hoodForward);
    expect(far.hoodUp).toBe(VEHICLE_RIG.hoodUp);
    expect(far.cockpitForward).toBe(VEHICLE_RIG.cockpitForward);
    expect(far.cockpitUp).toBe(VEHICLE_RIG.cockpitUp);
  });

  it('means the same thing on foot as in the car — a transform, not absolute metres', () => {
    const factor = 0.6;
    const car = applyCameraSettings(VEHICLE_RIG, settings({ distance: factor }));
    const foot = applyCameraSettings(FOOT_RIG, settings({ distance: factor }));
    expect(car.chaseBack / VEHICLE_RIG.chaseBack).toBeCloseTo(foot.chaseBack / FOOT_RIG.chaseBack, 6);
    // ...and the two rigs still differ, which is the whole reason they exist.
    expect(car.chaseBack).toBeGreaterThan(foot.chaseBack);
  });

  it('raises the boom without lengthening it: pitch changes elevation, distance changes reach', () => {
    const base = Math.hypot(VEHICLE_RIG.chaseBack, VEHICLE_RIG.chaseUp);
    const up = applyCameraSettings(VEHICLE_RIG, settings({ pitch: 20 }));
    expect(Math.hypot(up.chaseBack, up.chaseUp)).toBeCloseTo(base, 6);
    expect(up.chaseUp).toBeGreaterThan(VEHICLE_RIG.chaseUp);
    expect(up.chaseBack).toBeLessThan(VEHICLE_RIG.chaseBack);

    const down = applyCameraSettings(VEHICLE_RIG, settings({ pitch: -15 }));
    expect(Math.hypot(down.chaseBack, down.chaseUp)).toBeCloseTo(base, 6);
    expect(down.chaseUp).toBeLessThan(VEHICLE_RIG.chaseUp);
  });

  it('keeps the cinematic shot on its own bearing while its elevation moves', () => {
    const raised = applyCameraSettings(VEHICLE_RIG, settings({ pitch: 25 }));
    // Back and side scale together, so the flank the shot is taken from is unchanged.
    expect(raised.cinematicBack / raised.cinematicSide)
      .toBeCloseTo(VEHICLE_RIG.cinematicBack / VEHICLE_RIG.cinematicSide, 6);
    expect(raised.cinematicUp).toBeGreaterThan(VEHICLE_RIG.cinematicUp);
  });

  it('never swings the boom below the body or straight overhead, whatever the dial says', () => {
    for (const pitch of [CAMERA_SETTING_BOUNDS.pitch.min, CAMERA_SETTING_BOUNDS.pitch.max]) {
      const applied = applyCameraSettings(VEHICLE_RIG, settings({ pitch }));
      expect(applied.chaseUp).toBeGreaterThan(0);
      expect(applied.chaseBack).toBeGreaterThan(0);
      expect(applied.orbitUp).toBeGreaterThan(0);
      expect(applied.orbitRadius).toBeGreaterThan(0);
    }
  });

  it('tilts the first-person aim instead, since those modes have no boom to swing', () => {
    const level = applyCameraSettings(VEHICLE_RIG, settings({ pitch: 0 }));
    const raised = applyCameraSettings(VEHICLE_RIG, settings({ pitch: 20 }));
    const body = new THREE.Vector3(0, 0, 0);
    const aimAt = (rig: typeof level) => resolveCameraPlacement('hood', rig, body, 0, 0);

    const levelAim = aimAt(level);
    const raisedAim = aimAt(raised);
    // The eye stays put; only what it is pointed at moves.
    expect(raisedAim.position.y).toBeCloseTo(levelAim.position.y, 6);
    expect(raisedAim.lookAt.y).toBeGreaterThan(levelAim.lookAt.y);
    // And it still looks the same distance down the road, not at a nearer point on the sky.
    expect(raisedAim.lookAt.z).toBeCloseTo(levelAim.lookAt.z, 6);
  });
});

describe('clampPlacementAboveGround', () => {
  const placementAt = (y: number) => ({
    position: new THREE.Vector3(4, y, -7),
    lookAt: new THREE.Vector3(0, 1.2, 0),
  });

  it('lifts a camera that has ended up under the ground, and leaves a clear one alone', () => {
    const sunk = clampPlacementAboveGround(placementAt(-3), () => 2, 0.6);
    expect(sunk.position.y).toBeCloseTo(2.6, 6);

    const clear = clampPlacementAboveGround(placementAt(9), () => 2, 0.6);
    expect(clear.position.y).toBeCloseTo(9, 6);
  });

  it('moves only the camera, never the shot: the look target is untouched', () => {
    const placement = placementAt(-3);
    const lookAt = placement.lookAt.clone();
    clampPlacementAboveGround(placement, () => 2, 0.6);
    expect(placement.lookAt).toEqual(lookAt);
    // ...and it does not slide the camera horizontally either.
    expect(placement.position.x).toBeCloseTo(4, 6);
    expect(placement.position.z).toBeCloseTo(-7, 6);
  });

  it('samples the surface under the camera, not under the body it is following', () => {
    const asked: Array<[number, number]> = [];
    clampPlacementAboveGround(placementAt(0), (x, z) => { asked.push([x, z]); return 0; }, 0.6);
    expect(asked).toEqual([[4, -7]]);
  });

  it('reads the deck a bridge puts underfoot, not just the terrain below it', () => {
    // The sampler the runtime injects answers with the road profile where one covers the
    // point, which is what keeps the camera on top of a deck rather than under it.
    const deckHeight = 6.4;
    const onDeck = clampPlacementAboveGround(placementAt(5), () => deckHeight, 0.6);
    expect(onDeck.position.y).toBeCloseTo(deckHeight + 0.6, 6);
  });
});

describe('pullPlacementClearOfObstruction', () => {
  const place = (pos: [number, number, number], look: [number, number, number]) => ({
    position: new THREE.Vector3(...pos),
    lookAt: new THREE.Vector3(...look),
  });
  /** A wall standing across the sightline at `at` metres from the look target. */
  const wallAt = (at: number) => () => at;
  const clear = () => null;

  it('leaves a clear sightline exactly where it was', () => {
    const p = place([0, 3, 10], [0, 1, 0]);
    const before = p.position.clone();
    pullPlacementClearOfObstruction(p, clear, 0.6, 1.2);
    expect(p.position.distanceTo(before)).toBeCloseTo(0, 10);
  });

  it('pulls the camera in to just short of an obstruction', () => {
    // The cinematic case: a facade between the camera and the player. The boom shortens;
    // the camera does not rise over the building, which would swing the shot to a roof
    // view every time the player walked past one.
    const p = place([0, 1, 10], [0, 1, 0]);
    pullPlacementClearOfObstruction(p, wallAt(6), 0.6, 1.2);
    expect(p.position.z).toBeCloseTo(5.4, 6);
    expect(p.position.y).toBeCloseTo(1, 6);
  });

  it('never moves the look target', () => {
    // Being pushed off an obstruction must not also re-aim the shot.
    const p = place([0, 5, 10], [3, 1, 2]);
    pullPlacementClearOfObstruction(p, wallAt(4), 0.6, 1.2);
    expect(p.lookAt.toArray()).toEqual([3, 1, 2]);
  });

  it('keeps the camera on its own sightline', () => {
    // Whatever it does, the composition's direction is preserved — only the distance
    // along it changes.
    const p = place([6, 8, -3], [1, 2, 1]);
    const dir = p.position.clone().sub(p.lookAt).normalize();
    pullPlacementClearOfObstruction(p, wallAt(3), 0.5, 1.2);
    const after = p.position.clone().sub(p.lookAt);
    expect(after.clone().normalize().distanceTo(dir)).toBeCloseTo(0, 9);
    expect(after.length()).toBeCloseTo(2.5, 6);
  });

  it('holds the boom at the minimum rather than collapsing onto the subject', () => {
    // A camera wedged into a corner should clip a little, not end up inside the body it
    // is framing.
    const p = place([0, 1, 10], [0, 1, 0]);
    pullPlacementClearOfObstruction(p, wallAt(0.2), 0.6, 1.2);
    expect(p.position.distanceTo(p.lookAt)).toBeCloseTo(1.2, 6);
  });

  it('ignores a hit further away than the camera itself', () => {
    // A wall behind the camera is not between it and the subject.
    const p = place([0, 1, 5], [0, 1, 0]);
    pullPlacementClearOfObstruction(p, wallAt(40), 0.6, 1.2);
    expect(p.position.z).toBeCloseTo(5, 6);
  });

  it('does nothing for a camera sitting on its own target', () => {
    // The first-person modes are inside the body they follow by design, and have no
    // sightline to test.
    const p = place([2, 1, 3], [2, 1, 3]);
    pullPlacementClearOfObstruction(p, wallAt(0.1), 0.6, 1.2);
    expect(p.position.toArray()).toEqual([2, 1, 3]);
  });

  it('casts from the target outward, so the nearest obstruction wins', () => {
    // Casting inward from the camera would find the far side of a wall the camera is
    // already behind, and happily leave it there.
    const seen: Array<[number, number, number, number]> = [];
    const p = place([0, 4, 12], [0, 2, 0]);
    pullPlacementClearOfObstruction(p, (fx, fy, fz, dx, dy, dz, max) => {
      seen.push([fx, fy, fz, max]);
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 9);
      return null;
    }, 0.6, 1.2);
    expect(seen[0][0]).toBe(0);
    expect(seen[0][1]).toBe(2);   // the look target, not the camera
    expect(seen[0][2]).toBe(0);
    expect(seen[0][3]).toBeCloseTo(Math.hypot(2, 12), 6);
  });

  it('works for a top-down boom, which is straight up', () => {
    // top-down was excluded from clamping on the reasoning that it is far above
    // everything by construction — false under a tree, where its fixed boom puts it
    // inside the canopy.
    const p = place([0, 18, 0.01], [0, 1, 0]);
    pullPlacementClearOfObstruction(p, wallAt(9), 0.6, 1.2);
    expect(p.position.distanceTo(p.lookAt)).toBeCloseTo(8.4, 6);
    expect(p.position.y).toBeLessThan(18);
  });
});
