/**
 * Names the street a point is standing on.
 *
 * Vector tiles carry a road's name as a separate label point somewhere near the middle
 * of the way, with no link back to the geometry — so this is a two-stage guess: find the
 * road the point is actually on, then find the name most likely to belong to it. Both
 * the HUD area readout and the bus's saloon sign run off this, which is why it prefers
 * returning a slightly stale-but-plausible name over returning nothing: a sign that
 * blanks out every time a label falls out of range reads as broken.
 */
import type { LocalPoint, WorldLabel, WorldRoad } from '../world/types';

/** How far a label may sit from a road and still be taken as that road's name. Vector
 * tiles place a way's label near its midpoint, but a long way spans several tiles and
 * each carries its own label point, so the offset is small in practice. */
const LABEL_ASSOCIATION_DISTANCE = 45;
/**
 * Fallback radius, used only when no label could be tied to the road underfoot. A
 * junction is the common case: the point sits on an unnamed service stub while the
 * street it is plainly part of has its label a few tens of metres away. Wide enough to
 * cross a junction, tight enough not to borrow the name of the next block.
 */
const NEAREST_LABEL_DISTANCE = 70;
/** Longest name a dot-matrix sign or the HUD line can show without truncating oddly. */
const DISPLAY_CHARACTER_LIMIT = 24;

const STREET_LABEL_CATEGORIES = new Set(['street', 'road']);

function isStreetLabel(label: WorldLabel): boolean {
  return STREET_LABEL_CATEGORIES.has((label.category ?? '').toLowerCase());
}

function pointToSegmentDistance(point: LocalPoint, start: LocalPoint, end: LocalPoint): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.z - start.z);
  const amount = Math.min(1, Math.max(
    0,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
  ));
  return Math.hypot(
    point.x - (start.x + dx * amount),
    point.z - (start.z + dz * amount),
  );
}

function distanceToRoad(point: LocalPoint, road: WorldRoad): number {
  if (road.points.length < 2) return Number.POSITIVE_INFINITY;
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < road.points.length; index += 1) {
    nearest = Math.min(
      nearest,
      pointToSegmentDistance(point, road.points[index - 1], road.points[index]),
    );
  }
  return nearest;
}

/** The street label closest to `point`, among those passing `accept`. */
function nearestLabel(
  point: LocalPoint,
  labels: WorldLabel[],
  maximumDistance: number,
  accept: (label: WorldLabel) => boolean,
): string | null {
  let best: string | null = null;
  let bestDistance = maximumDistance;
  for (const label of labels) {
    if (!isStreetLabel(label) || !accept(label)) continue;
    const distance = Math.hypot(label.point.x - point.x, label.point.z - point.z);
    if (distance > bestDistance) continue;
    bestDistance = distance;
    best = label.text.trim() || null;
  }
  return best;
}

export function resolveCurrentStreet(
  point: LocalPoint,
  roads: WorldRoad[],
  labels: WorldLabel[],
  maximumDistance = 35,
): string | null {
  let nearestRoad: WorldRoad | null = null;
  let nearestRoadDistance = maximumDistance;
  for (const road of roads) {
    const distance = distanceToRoad(point, road);
    if (distance <= nearestRoadDistance) {
      nearestRoad = road;
      nearestRoadDistance = distance;
    }
  }
  // No road underfoot means no street to be on, whatever labels happen to be nearby.
  if (!nearestRoad) return null;

  const onThisRoad = nearestLabel(
    point,
    labels,
    Number.POSITIVE_INFINITY,
    (label) => distanceToRoad(label.point, nearestRoad) <= LABEL_ASSOCIATION_DISTANCE,
  );
  const name = onThisRoad ?? nearestLabel(point, labels, NEAREST_LABEL_DISTANCE, () => true);
  return name ? name.slice(0, DISPLAY_CHARACTER_LIMIT) : null;
}
