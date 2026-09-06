/** Ranks a world's labels by proximity and heading relative to one point, for the HUD's nearby-places list. */
import type { WorldLabel } from '../world/types';

export interface NearbyItem {
  name: string;
  category: string;
  detail?: string;
  distance: number;
  direction: 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind';
}

const NEARBY_RADIUS = 500;
const NEARBY_LIMIT = 16;

export function rankNearbyPlaces(labels: WorldLabel[], originX: number, originZ: number, heading: number): NearbyItem[] {
  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  return labels.map((label) => {
    const dx = label.point.x - originX;
    const dz = label.point.z - originZ;
    const distance = Math.hypot(dx, dz);
    const forwardDot = distance > 0 ? (dx * forwardX + dz * forwardZ) / distance : 1;
    const sideDot = distance > 0 ? (dx * forwardZ - dz * forwardX) / distance : 0;
    const direction: NearbyItem['direction'] = forwardDot > 0.72
      ? Math.abs(sideDot) < 0.25 ? 'ahead' : sideDot > 0 ? 'ahead-left' : 'ahead-right'
      : forwardDot < -0.35 ? 'behind' : sideDot > 0 ? 'left' : 'right';
    return {
      name: label.text, category: label.category ?? 'Place', detail: label.detail,
      distance: Math.round(distance), direction, forwardDot,
      score: distance - Math.max(0, forwardDot) * 260 + (forwardDot < 0 ? 280 : 0),
    };
  }).filter((item) => item.distance <= NEARBY_RADIUS)
    .sort((a, b) => a.score - b.score)
    .slice(0, NEARBY_LIMIT);
}
