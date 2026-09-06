import { describe, expect, it } from 'vitest';
import {
  CAMP_LOCATION, CAMP_VOICES, LISTEN_RADIUS,
  campLayout, createCampVoices, flameLevel, nearestListener, resolveCampPoint, speak,
} from '../../src/svartaksi/bonfireCamp';
import type { LocalPoint } from '../../src/world/types';

describe('campLayout', () => {
  it('seats every voice on the ring, each facing the fire', () => {
    const seats = campLayout();
    expect(seats).toHaveLength(CAMP_VOICES.length);
    for (const seat of seats) {
      const distance = Math.hypot(seat.offset.x, seat.offset.z);
      expect(distance).toBeGreaterThan(1.5);
      expect(distance).toBeLessThan(3.5);
      // Facing the fire means the seat's forward vector points back at the origin, so
      // the dot product with its own outward offset is negative.
      const forward = { x: Math.sin(seat.yaw), z: Math.cos(seat.yaw) };
      expect(forward.x * seat.offset.x + forward.z * seat.offset.z).toBeLessThan(0);
    }
  });

  it('leaves an open side rather than spacing the ring evenly', () => {
    const seats = campLayout();
    const angles = seats.map((seat) => Math.atan2(seat.offset.x, seat.offset.z));
    const gaps = angles.map((angle, index) => {
      const next = angles[(index + 1) % angles.length];
      return (next - angle + Math.PI * 2) % (Math.PI * 2);
    });
    const even = (Math.PI * 2) / seats.length;
    expect(Math.max(...gaps)).toBeGreaterThan(even * 1.4);
  });

  it('is deterministic', () => {
    expect(campLayout()).toEqual(campLayout());
  });
});

describe('speak', () => {
  it('walks one voice through its own lines in order', () => {
    const voices = createCampVoices();
    const said = CAMP_VOICES[0].map(() => speak(voices, 0));
    expect(said).toEqual([...CAMP_VOICES[0]]);
  });

  it('wraps rather than falling silent', () => {
    const voices = createCampVoices();
    const lines = CAMP_VOICES[1];
    for (let index = 0; index < lines.length; index += 1) speak(voices, 1);
    expect(speak(voices, 1)).toBe(lines[0]);
  });

  it('advances each voice independently', () => {
    const voices = createCampVoices();
    speak(voices, 0);
    speak(voices, 0);
    expect(speak(voices, 2)).toBe(CAMP_VOICES[2][0]);
    expect(speak(voices, 0)).toBe(CAMP_VOICES[0][2]);
  });

  it('returns null for a speaker that does not exist', () => {
    const voices = createCampVoices();
    expect(speak(voices, 99)).toBeNull();
    expect(speak(voices, -1)).toBeNull();
  });
});

describe('nearestListener', () => {
  const seats = campLayout();

  it('answers -1 from outside the ring', () => {
    expect(nearestListener(seats, 0, 0, 50, 50)).toBe(-1);
  });

  it('picks the closest pill, so walking round the fire changes who answers', () => {
    const first = seats[0];
    const third = seats[2];
    expect(nearestListener(seats, 0, 0, first.offset.x, first.offset.z)).toBe(0);
    expect(nearestListener(seats, 0, 0, third.offset.x, third.offset.z)).toBe(2);
  });

  it('is measured from the camp, not the world origin', () => {
    const seat = seats[0];
    // The same body position that hears seat 0 at a camp on the origin hears nobody
    // once the camp is a hundred metres away.
    expect(nearestListener(seats, 100, -60, seat.offset.x, seat.offset.z)).toBe(-1);
    expect(nearestListener(seats, 100, -60, 100 + seat.offset.x, -60 + seat.offset.z)).toBe(0);
  });

  it('respects the radius at its boundary', () => {
    const seat = seats[0];
    const outward = Math.hypot(seat.offset.x, seat.offset.z);
    const justOutside = (outward + LISTEN_RADIUS + 0.1) / outward;
    expect(nearestListener(seats, 0, 0, seat.offset.x * justOutside, seat.offset.z * justOutside)).toBe(-1);
  });
});

describe('resolveCampPoint', () => {
  const authored: LocalPoint = { x: -914, z: 327 };

  it('leaves a usable authored point exactly where it was authored', () => {
    expect(resolveCampPoint(authored, () => true)).toEqual(authored);
  });

  it('nudges to the closest clear point when the authored one is blocked', () => {
    // Everything within 20m of the authored point is inside something.
    const isSafe = (point: LocalPoint) =>
      Math.hypot(point.x - authored.x, point.z - authored.z) > 20;
    const resolved = resolveCampPoint(authored, isSafe);
    const moved = Math.hypot(resolved.x - authored.x, resolved.z - authored.z);
    expect(moved).toBeGreaterThan(20);
    // The widening search stops at the first ring that clears, so it does not wander
    // further than it has to.
    expect(moved).toBeLessThan(30);
  });

  it('gives up and returns the authored point rather than moving the camp miles', () => {
    expect(resolveCampPoint(authored, () => false)).toEqual(authored);
  });
});

describe('flameLevel', () => {
  it('stays inside the range the model scales and lights from', () => {
    for (let time = 0; time < 120; time += 0.05) {
      const level = flameLevel(time);
      expect(level).toBeGreaterThan(0.5);
      expect(level).toBeLessThanOrEqual(1.001);
    }
  });

  it('is a pure function of the clock, so a rebuild or a dropped frame changes nothing', () => {
    expect(flameLevel(12.5)).toBe(flameLevel(12.5));
    expect(flameLevel(0)).not.toBe(flameLevel(0.4));
  });

  it('actually varies rather than settling on a value', () => {
    const samples = Array.from({ length: 200 }, (_value, index) => flameLevel(index * 0.11));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.25);
  });
});

describe('CAMP_LOCATION', () => {
  it('is the authored spot in Ryssbergen, west of the start', () => {
    expect(CAMP_LOCATION.lng).toBeCloseTo(18.14762, 5);
    expect(CAMP_LOCATION.lat).toBeCloseTo(59.313237, 5);
  });
});
