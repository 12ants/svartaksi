/**
 * When the world re-streams.
 *
 * The trigger this covers replaced one that compared each frame's look-ahead point
 * against the last stream's look-ahead point. Both swing with the player's heading, so
 * turning read as travelling — which is why the world rebuilt every few seconds during
 * ordinary driving. These tests hold the distinction the new rule is built on.
 */
import { describe, expect, it } from 'vitest';
import { predictStreamCenter, shouldRestream } from '@/world/streamPrediction';

const LOOK_AHEAD = 420;
const OPTIONS = { travelDistance: 520, coverageRadius: 1_500 };

/** The look-ahead point for a player standing at `player` facing `heading`. */
function lookAhead(player: { x: number; z: number }, heading: number) {
  return {
    x: player.x + Math.sin(heading) * LOOK_AHEAD,
    z: player.z + Math.cos(heading) * LOOK_AHEAD,
  };
}

describe('shouldRestream', () => {
  const origin = { x: 0, z: 0 };
  const center = lookAhead(origin, 0);

  it('does not re-stream a car that has turned but not moved', () => {
    for (const heading of [Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      expect(shouldRestream(origin, lookAhead(origin, heading), origin, center, OPTIONS))
        .toBe(false);
    }
  });

  it('does not re-stream on a camera change that shortens the look-ahead', () => {
    // The top-down camera looks 120m ahead where the chase camera looks 420m; under the
    // old rule that 300m step was enough to count as movement on its own.
    const topDown = { x: 0, z: 120 };

    expect(shouldRestream(origin, topDown, origin, center, OPTIONS)).toBe(false);
  });

  it('re-streams once the player has driven the threshold', () => {
    const near = { x: 0, z: 519 };
    const past = { x: 0, z: 521 };

    expect(shouldRestream(near, lookAhead(near, 0), origin, center, OPTIONS)).toBe(false);
    expect(shouldRestream(past, lookAhead(past, 0), origin, center, OPTIONS)).toBe(true);
  });

  it('measures that travel in any direction, not just forwards', () => {
    const sideways = { x: 560, z: 0 };

    expect(shouldRestream(sideways, lookAhead(sideways, 0), origin, center, OPTIONS)).toBe(true);
  });

  it('re-streams when the player turns towards ground the last load never reached', () => {
    // Far enough out that looking onwards points past the loaded radius, but not far
    // enough to have travelled the threshold. The player is at z=500, the load was
    // centred at z=420, so looking on puts the look-ahead 500m beyond that centre and
    // looking back puts it 340m short of it.
    const player = { x: 0, z: 500 };
    const outward = lookAhead(player, 0);
    const backwards = lookAhead(player, Math.PI);
    const tightOptions = { travelDistance: 520, coverageRadius: 400 };

    expect(shouldRestream(player, outward, origin, center, tightOptions)).toBe(true);
    // Looking back the way they came is still covered — that is where they came from.
    expect(shouldRestream(player, backwards, origin, center, tightOptions)).toBe(false);
  });

  it('measures coverage from the loaded centre, not from the previous look-ahead', () => {
    // Standing on the loaded centre, every direction is inside the radius, however far the
    // player is from where they last streamed *from*.
    const player = { ...center };

    for (const heading of [0, Math.PI / 2, Math.PI]) {
      expect(shouldRestream(player, lookAhead(player, heading), player, center, OPTIONS))
        .toBe(false);
    }
  });

  it('refuses to act on a position that is not a number', () => {
    expect(shouldRestream({ x: NaN, z: 0 }, center, origin, center, OPTIONS)).toBe(false);
  });
});

describe('predictStreamCenter', () => {
  it('still leads the player by the distance it is asked for, within its own bounds', () => {
    const ahead = predictStreamCenter({ x: 0, z: 0 }, 0, 360);

    expect(ahead.z).toBeCloseTo(360);
    expect(ahead.x).toBeCloseTo(0);
  });
});
