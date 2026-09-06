/**
 * Procedurally places post boxes along the streets people actually live and walk on,
 * the same way streetLights places lamp posts and busStops places shelters: OSM's
 * `amenity=post_box` nodes exist but are mapped by a handful of enthusiasts, so a whole
 * suburb can have none at all while the next block has three.
 *
 * Pure geometry in, placements out; threeWorld turns placements into instanced meshes.
 */
import { getRoadFamily } from '../svartaksi/roadStyle';
import { isPavementClear } from './roadClearance';
import type { LocalPoint, WorldBuilding, WorldRoad } from './types';

export interface MailboxPlacement {
  x: number;
  z: number;
  /** Height of the surface the box stands on — see BusStopPlacement's own `y`. */
  y?: number;
  /** Yaw (radians) so the posting slot faces the pavement, away from the carriageway. */
  yaw: number;
}

/** Road kinds a post box stands beside. A post box is street furniture for people on
 * foot, so this is the minor family plus tertiary — not motorway or trunk, where the
 * only way to reach one would be to walk down the hard shoulder. */
const MAILBOX_ROAD_KINDS = new Set([
  'residential', 'living_street', 'unclassified', 'tertiary', 'service',
]);

/** Meters between boxes. Sparser than shelters: emptying a post box is a daily round,
 * and a real neighbourhood has a handful, not one per corner. */
export const MAILBOX_SPACING = 470;
/** Clearance beyond the paved edge before the pole's centre. Smaller than a shelter's
 * because the box is 0.5m wide and stands right at the kerb. */
const MAILBOX_SETBACK = 1.9;
/** Roads shorter than this are skipped: a box on a 60m service spur reads as litter
 * dropped by the generator rather than as part of a postal round. */
const MIN_ROAD_LENGTH = 150;
/** Two boxes closer than this are the same box as far as a resident is concerned, and
 * near a junction two roads will each want one. Also the radius kept clear of anything
 * passed in `avoid` — a box standing inside a bus shelter is the giveaway that this is
 * generated furniture. */
const MIN_SEPARATION = 40;

function roadLength(road: WorldRoad): number {
  let total = 0;
  for (let index = 0; index < road.points.length - 1; index += 1) {
    const a = road.points[index];
    const b = road.points[index + 1];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

/**
 * Walks each qualifying road and drops a box every MAILBOX_SPACING meters, always on
 * the same side of a given road rather than alternating: a postal round follows one
 * kerb, and alternating put boxes facing each other across a residential street, which
 * reads as a sorting office rather than a neighbourhood. Which side is chosen from the
 * road's own id so the same road picks the same kerb on every rebuild.
 *
 * `avoid` is other street furniture already placed (the bus shelters) — a box is pushed
 * to the next spacing rather than planted inside one.
 */
export function generateMailboxes(
  roads: WorldRoad[],
  avoid: readonly { x: number; z: number }[] = [],
  buildings: WorldBuilding[] = [],
): MailboxPlacement[] {
  const boxes: MailboxPlacement[] = [];
  for (const road of roads) {
    if (getRoadFamily(road.kind) === 'path') continue;
    if (!MAILBOX_ROAD_KINDS.has(road.kind)) continue;
    if (road.points.length < 2) continue;
    if (roadLength(road) < MIN_ROAD_LENGTH) continue;
    const offset = road.width / 2 + MAILBOX_SETBACK;
    // Deterministic per road, so a stream or a quality change never shuffles boxes
    // across the street while the player is looking at them.
    let hash = 0;
    for (let index = 0; index < road.id.length; index += 1) hash = (hash * 31 + road.id.charCodeAt(index)) | 0;
    const side = hash % 2 === 0 ? 1 : -1;
    // Two thirds of a spacing already "travelled", so the first box lands a third of a
    // spacing in — off the junction every corridor's ways start at, without giving up a
    // whole spacing of a short street.
    let sinceLast = (MAILBOX_SPACING * 2) / 3;
    for (let index = 0; index < road.points.length - 1; index += 1) {
      const a = road.points[index];
      const b = road.points[index + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segmentLength = Math.hypot(dx, dz);
      if (segmentLength < 1e-6) continue;
      const dirX = dx / segmentLength;
      const dirZ = dz / segmentLength;
      const normalX = -dirZ;
      const normalZ = dirX;
      let traveled = 0;
      while (sinceLast + (segmentLength - traveled) >= MAILBOX_SPACING) {
        traveled += MAILBOX_SPACING - sinceLast;
        const x = a.x + dirX * traveled + normalX * offset * side;
        const z = a.z + dirZ * traveled + normalZ * offset * side;
        // Same reason as the shelters: the per-road setback only clears *this* road, and
        // a bend, a parallel way, or a building's own footprint can put the point back
        // onto pavement.
        if (isPavementClear(x, z, roads, 0.4, buildings, [...avoid, ...boxes], MIN_SEPARATION)) {
          // Local +Z is the slot side, which has to face the pavement — the outward
          // normal for whichever kerb this box stands on.
          boxes.push({ x, z, yaw: Math.atan2(-dirZ * side, dirX * side) });
        }
        sinceLast = 0;
      }
      sinceLast += segmentLength - traveled;
    }
  }
  return boxes;
}

/**
 * Turns individually mapped `amenity=post_box` nodes into placements, so a box someone
 * actually surveyed gets the same model as a generated one instead of a separate,
 * cruder prop. The node carries a position but no orientation, so the yaw is taken from
 * the nearest road: the slot faces the side of that road the box already stands on.
 * With no road anywhere near, the box keeps yaw 0 rather than being dropped — an
 * unaligned box still beats no box where a surveyor put one.
 */
export function mappedMailboxes(points: readonly LocalPoint[], roads: WorldRoad[]): MailboxPlacement[] {
  return points.map((point) => {
    let bestDistance = Infinity;
    let yaw = 0;
    for (const road of roads) {
      for (let index = 0; index < road.points.length - 1; index += 1) {
        const a = road.points[index];
        const b = road.points[index + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
        const offsetX = point.x - (a.x + dx * t);
        const offsetZ = point.z - (a.z + dz * t);
        const distance = Math.hypot(offsetX, offsetZ);
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        // Straight away from the centerline is the outward normal at the closest point,
        // which is the offset vector itself. Degenerate only if the box sits exactly on
        // the centerline, where any facing is as good as another.
        yaw = distance < 1e-6 ? 0 : Math.atan2(offsetX, offsetZ);
      }
    }
    return { x: point.x, z: point.z, yaw };
  });
}
