import type { LocalPoint } from '../world/types';

const DEFAULT_START: LocalPoint = { x: 0.88, z: -4.35 };

const CONTROL_POINTS: readonly LocalPoint[] = [
  { x: 0, z: -3.7 },
  { x: 0, z: -2.2 },
  { x: -1.26, z: -2.2 },
  { x: -2.4, z: -2.2 },
];

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

export function sampleAlightPath(progress: number, start: LocalPoint = DEFAULT_START): LocalPoint {
  const clamped = Math.min(1, Math.max(0, progress));
  const segmentCount = CONTROL_POINTS.length;
  const scaled = clamped * segmentCount;
  const index = Math.min(segmentCount - 1, Math.floor(scaled));
  const amount = smoothstep(scaled - index);
  const segmentStart = index === 0 ? start : CONTROL_POINTS[index - 1];
  const end = CONTROL_POINTS[index];
  return {
    x: segmentStart.x + (end.x - segmentStart.x) * amount,
    z: segmentStart.z + (end.z - segmentStart.z) * amount,
  };
}
