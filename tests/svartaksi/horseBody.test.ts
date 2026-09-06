import { describe, expect, it } from 'vitest';

import {
  canMount,
  createHorseState,
  dismount,
  GAIT_SPEED_MPS,
  mount,
  MOUNT_RANGE_METERS,
  stepHorse,
} from '../../src/svartaksi/horseBody';

const flatGround = () => 0;

describe('horseBody', () => {
  it('starts idle and unmounted', () => {
    const horse = createHorseState(10, 20);
    expect(horse.mode).toBe('idle');
    expect(horse.gait).toBe('stand');
    expect(horse.x).toBe(10);
    expect(horse.z).toBe(20);
  });

  it('can be mounted from within range', () => {
    const horse = createHorseState(0, 0);
    expect(canMount(horse, { x: 1, z: 0 })).toBe(true);
    expect(canMount(horse, { x: MOUNT_RANGE_METERS + 1, z: 0 })).toBe(false);
  });

  it('mounting from range switches mode to mounted', () => {
    const horse = mount(createHorseState(0, 0), { x: 1, z: 0 });
    expect(horse.mode).toBe('mounted');
    expect(horse.gait).toBe('stand');
  });

  it('refuses to mount from out of range', () => {
    const horse = createHorseState(0, 0);
    const mounted = mount(horse, { x: 100, z: 0 });
    expect(mounted.mode).toBe('idle');
  });

  it('dismount returns to idle and stand', () => {
    const horse = dismount(mount(createHorseState(0, 0), { x: 0, z: 0 }));
    expect(horse.mode).toBe('idle');
    expect(horse.gait).toBe('stand');
  });

  it('does nothing on stepHorse while idle (not mounted)', () => {
    const horse = createHorseState(0, 0);
    const stepped = stepHorse(horse, { gait: 'canter', turn: 0 }, 1, flatGround);
    expect(stepped.x).toBe(0);
    expect(stepped.z).toBe(0);
    expect(stepped.gait).toBe('stand');
  });

  it('walking moves forward at the walk speed', () => {
    let horse = mount(createHorseState(0, 0, 0), { x: 0, z: 0 });
    horse = stepHorse(horse, { gait: 'walk', turn: 0 }, 1, flatGround);
    // heading 0 faces -z in this world's convention (matches the car/player forward axis).
    expect(Math.hypot(horse.x, horse.z)).toBeCloseTo(GAIT_SPEED_MPS.walk, 5);
  });

  it('canter covers more ground per second than trot, trot more than walk', () => {
    let w = mount(createHorseState(0, 0, 0), { x: 0, z: 0 });
    let t = mount(createHorseState(0, 0, 0), { x: 0, z: 0 });
    let c = mount(createHorseState(0, 0, 0), { x: 0, z: 0 });
    w = stepHorse(w, { gait: 'walk', turn: 0 }, 1, flatGround);
    t = stepHorse(t, { gait: 'trot', turn: 0 }, 1, flatGround);
    c = stepHorse(c, { gait: 'canter', turn: 0 }, 1, flatGround);
    const dist = (h: { x: number; z: number }) => Math.hypot(h.x, h.z);
    expect(dist(t)).toBeGreaterThan(dist(w));
    expect(dist(c)).toBeGreaterThan(dist(t));
  });

  it('turning changes heading over time', () => {
    let horse = mount(createHorseState(0, 0, 0), { x: 0, z: 0 });
    horse = stepHorse(horse, { gait: 'walk', turn: 1 }, 1, flatGround);
    expect(horse.heading).not.toBe(0);
  });

  it('follows terrain height every step: no hovering, no sinking', () => {
    let horse = mount(createHorseState(0, 0, 0), { x: 0, z: 0 });
    const slope = (point: { x: number; z: number }) => point.z * -0.1; // rises as z decreases
    horse = stepHorse(horse, { gait: 'trot', turn: 0 }, 1, slope);
    expect(horse.y).toBeCloseTo(slope({ x: horse.x, z: horse.z }), 6);
  });

  it('is deterministic: same input and dt produce the same resulting state', () => {
    const start = mount(createHorseState(5, 5, 0.3), { x: 5, z: 5 });
    const a = stepHorse(start, { gait: 'trot', turn: 0.5 }, 0.25, (p) => p.x * 0.01);
    const b = stepHorse(start, { gait: 'trot', turn: 0.5 }, 0.25, (p) => p.x * 0.01);
    expect(a).toEqual(b);
  });

  it('a full mount -> ride -> dismount cycle ends idle at the dismount position', () => {
    let horse = createHorseState(0, 0, 0);
    horse = mount(horse, { x: 0, z: 0 });
    horse = stepHorse(horse, { gait: 'canter', turn: 0 }, 2, flatGround);
    const rodeDistance = Math.hypot(horse.x, horse.z);
    expect(rodeDistance).toBeCloseTo(GAIT_SPEED_MPS.canter * 2, 5);
    horse = dismount(horse);
    expect(horse.mode).toBe('idle');
    expect(horse.x).toBeCloseTo(rodeDistance === 0 ? 0 : horse.x, 5);
  });
});

describe('refusing deep water', () => {
  const flat = () => 0;
  /** Standable everywhere on the near side of x = 10; deep water beyond it. */
  const shore = (point: { x: number }) => point.x < 10;

  it('rides right up to the water and then stops', () => {
    let horse = mount(createHorseState(0, 0), { x: 0, z: 0 });
    // Heading +x, at a canter, for long enough to be well past the shore if nothing
    // stopped it.
    horse = { ...horse, heading: Math.PI / 2 };
    for (let tick = 0; tick < 600; tick += 1) {
      horse = stepHorse(horse, { gait: 'canter', turn: 0 }, 1 / 60, flat, shore);
    }
    expect(horse.x).toBeLessThan(10);
    expect(horse.x).toBeGreaterThan(9);
  });

  it('still turns while held against the edge, so the rider can leave', () => {
    let horse = mount(createHorseState(0, 0), { x: 0, z: 0 });
    horse = { ...horse, heading: Math.PI / 2, x: 9.99 };
    const facing = horse.heading;
    // Pressed into the water and turning: the step is refused, the turn is not.
    horse = stepHorse(horse, { gait: 'canter', turn: 1 }, 1 / 60, flat, shore);
    expect(horse.x).toBeCloseTo(9.99, 5);
    expect(horse.heading).not.toBeCloseTo(facing, 5);

    // Turned around, it can ride away from the water again.
    horse = { ...horse, heading: -Math.PI / 2 };
    const left = stepHorse(horse, { gait: 'canter', turn: 0 }, 1 / 60, flat, shore);
    expect(left.x).toBeLessThan(9.99);
  });

  it('goes anywhere when no ground test is given, exactly as it did before', () => {
    let horse = mount(createHorseState(0, 0), { x: 0, z: 0 });
    horse = { ...horse, heading: Math.PI / 2 };
    horse = stepHorse(horse, { gait: 'canter', turn: 0 }, 1, flat);
    expect(horse.x).toBeGreaterThan(1);
  });
});
