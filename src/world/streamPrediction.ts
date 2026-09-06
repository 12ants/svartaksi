import type { LocalPoint } from './types';

const MIN_LOOK_AHEAD_METERS = 180;
const MAX_LOOK_AHEAD_METERS = 520;

export function predictStreamCenter(
  position: LocalPoint,
  heading: number,
  lookAheadMeters = 360,
): LocalPoint {
  if (![position.x, position.z, heading, lookAheadMeters].every(Number.isFinite)) {
    return { ...position };
  }
  const distance = Math.min(
    MAX_LOOK_AHEAD_METERS,
    Math.max(MIN_LOOK_AHEAD_METERS, lookAheadMeters),
  );
  return {
    x: clean(position.x + Math.sin(heading) * distance),
    z: clean(position.z + Math.cos(heading) * distance),
  };
}

function clean(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}
