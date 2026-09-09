/**
 * The bonfire in the woods: where it is, who is sitting round it, and what they say.
 *
 * Framework-agnostic on purpose (no React, no THREE, no DOM), for the same reason
 * `phone.ts` is: the interesting parts here are a layout and a set of ordered lines, and
 * neither should need a WebGL context to exercise. `bonfireModel.ts` turns the layout
 * into geometry; the runtime drives the listening.
 *
 * These are not quest-givers. They answer questions nobody asked and never explain
 * themselves, which is the whole of their characterisation — see `docs/story/README.md`
 * for the beat they belong to. The phone-for-GPS trade is deliberately not here yet.
 */
import type { LngLat, LocalPoint } from '../world/types';

/**
 * Ryssbergen, the wooded ridge west of Svartaksi Forum. Authored rather than found at
 * runtime: a landmark the player can be told about and walk back to is worth more than
 * one that moves with the data, and the alternative (nearest wood polygon to the origin)
 * put the fire somewhere different every time the tile source changed.
 *
 * Checked against OSM: `landuse=forest`, named, roughly 830 x 520m, and this point is
 * inside its outer ring. This is a fixed lng/lat, independent of START_LOCATION — it was
 * originally placed ~970m from the game's old Hammarbyhöjden start (inside that start's
 * building draw radius, so the camp had trees drawn around it from the first frame); it
 * does not move when START_LOCATION does, and is currently about 3.8km from the Gärdet
 * start, a drive rather than a walk. World data streams around wherever the player
 * actually is, so trees still draw in on approach — nothing here depends on proximity to
 * START_LOCATION specifically.
 */
export const CAMP_LOCATION: LngLat = { lng: 18.147620, lat: 59.313237 };

/** How close the pill has to be for a seated pill to acknowledge it, in metres. Bigger
 * than CAR_ENTER_RADIUS: you listen in on a fire from outside the ring of people at it,
 * you do not have to stand on someone. */
export const LISTEN_RADIUS = 6;

/** Radius of the ring the seated pills sit on. Two body-lengths back from the flames —
 * close enough to be lit by them, far enough that nobody is standing in the fire. */
const CAMP_RING_RADIUS = 2.3;

export interface CampSeat {
  /** Position relative to the fire, in metres. */
  offset: LocalPoint;
  /** Yaw, in the world's forward = (sin y, cos y) convention: every seat faces inward. */
  yaw: number;
  /** How far the pill leans forward toward the fire, in radians. */
  lean: number;
  /** 0..1 into the palette in bonfireModel — one per pill so the gang reads as several
   * people rather than one model repeated. */
  tint: number;
}

/**
 * Angles round the fire, in radians. Irregular on purpose: five seats at 72 degrees
 * apart reads as a clock face or a summoning circle, not as people who sat down where
 * there was room. The gap between the fourth and fifth is the widest, so the ring has an
 * open side to walk into.
 */
const SEAT_ANGLES = [0.35, 1.5, 2.45, 3.6, 5.5] as const;
/** Per-seat distance multiplier on CAMP_RING_RADIUS, and lean. Both hand-set for the
 * same reason the angles are: a fire nobody is quite square to. */
const SEAT_DISTANCE = [1, 0.88, 1.12, 0.95, 1.05] as const;
const SEAT_LEAN = [0.14, 0.05, 0.2, 0.09, 0.16] as const;

export function campLayout(): CampSeat[] {
  return SEAT_ANGLES.map((angle, index) => {
    const distance = CAMP_RING_RADIUS * SEAT_DISTANCE[index];
    const offset = { x: Math.sin(angle) * distance, z: Math.cos(angle) * distance };
    return {
      offset,
      // Facing the fire is facing back down the ray the seat sits on.
      yaw: angle + Math.PI,
      lean: SEAT_LEAN[index],
      tint: index / (SEAT_ANGLES.length - 1),
    };
  });
}

/** How far the camp may be nudged from its authored point, and in what steps, when the
 * authored point turns out to be unusable. Deliberately small: past this the fire is no
 * longer in the place it was authored to be in, and a camp 100m away in a car park is
 * worse than one that fails to move. */
const NUDGE_RADIUS = 45;
const NUDGE_STEP = 9;

/**
 * The authored point, or the nearest usable one to it.
 *
 * The map data behind a fixed coordinate is not fixed: a building can appear on top of
 * this spot in any tile refresh, and a camp inside a wall is the kind of thing nobody
 * notices until a screenshot. `isSafe` is the caller's containment test (water and
 * buildings, in practice); the search is a widening ring, so the answer is the closest
 * clear point rather than the first one that happens to be tried. Returns the authored
 * point unchanged when nothing within NUDGE_RADIUS is clear — being visibly in the wrong
 * place beats being silently somewhere else.
 */
export function resolveCampPoint(
  authored: LocalPoint,
  isSafe: (point: LocalPoint) => boolean,
): LocalPoint {
  if (isSafe(authored)) return authored;
  for (let radius = NUDGE_STEP; radius <= NUDGE_RADIUS; radius += NUDGE_STEP) {
    // Twelve bearings per ring: finer than that and the extra candidates fall inside a
    // shelter's worth of each other, which cannot change the answer.
    for (let step = 0; step < 12; step += 1) {
      const angle = (step / 12) * Math.PI * 2;
      const candidate = {
        x: authored.x + Math.sin(angle) * radius,
        z: authored.z + Math.cos(angle) * radius,
      };
      if (isSafe(candidate)) return candidate;
    }
  }
  return authored;
}

/**
 * What each pill says, in order, one line per press. Ordered rather than shuffled: the
 * lines of any one voice build on each other, and a random draw made five characters
 * read as one noise generator. The sequence wraps, so nobody ever runs out and nobody
 * ever announces that they are done.
 *
 * The rule they are written to: never name the person the player is looking for, never
 * confirm what the player already suspects, and never answer the question that was
 * actually asked. Anything that reads as a hint is a hint about the wrong thing.
 */
export const CAMP_VOICES: ReadonlyArray<ReadonlyArray<string>> = [
  [
    'You came on the bus. Everyone comes on the bus.',
    'Nobody has got off at the Forum since the timetable changed.',
    'The timetable did not change.',
    'Sit down. You are standing in the smoke.',
  ],
  [
    'Do not show us the phone.',
    'We know what it says. It said it to us as well.',
    'Ours stopped when we stopped reading them.',
    'Yours will stop too. Later than you would like.',
  ],
  [
    'Count the lit windows on the way back down.',
    'If it is the same number twice, walk slower.',
    'It is never the same number twice.',
    'Once it was. We do not talk about the man who counted.',
  ],
  [
    'She is not in the city.',
    'That is not the same as her not being here.',
    'Do not ask me which of those is worse.',
    'You are asking the fire, not me.',
    'The fire has been asked before.',
  ],
  [
    '…',
    'The wood is wet. It burns anyway.',
    'Somebody keeps stacking it.',
    'Not one of us. We have counted.',
  ],
];

/** One pill's state: which of its lines comes next. Kept as data rather than as a
 * closure so the runtime can hold five of them in a plain array and a test can drive
 * them without a scene. */
export interface CampVoiceState {
  spoken: number;
}

export function createCampVoices(): CampVoiceState[] {
  return CAMP_VOICES.map(() => ({ spoken: 0 }));
}

/**
 * Advances one voice and returns the line it just said. Wraps at the end of the
 * sequence, so a pill you keep listening to starts over rather than falling silent —
 * silence would read as a bug, and repetition reads as a character.
 */
export function speak(voices: CampVoiceState[], index: number): string | null {
  const lines = CAMP_VOICES[index];
  const state = voices[index];
  if (!lines?.length || !state) return null;
  const line = lines[state.spoken % lines.length];
  state.spoken += 1;
  return line;
}

/**
 * Which seated pill is close enough to hear, or -1. The nearest one wins: at a fire this
 * size two of them are always within LISTEN_RADIUS of each other, and picking the
 * nearest is what makes walking round the ring change who answers.
 */
export function nearestListener(
  seats: CampSeat[],
  campX: number,
  campZ: number,
  atX: number,
  atZ: number,
  radius = LISTEN_RADIUS,
): number {
  let best = -1;
  let bestDistance = radius;
  seats.forEach((seat, index) => {
    const distance = Math.hypot(campX + seat.offset.x - atX, campZ + seat.offset.z - atZ);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Flame brightness at a given clock time, 0.55..1. A sum of three incommensurable sines
 * rather than an accumulator or a random walk, for the reason every other animated thing
 * in this world is written that way: it is a pure function of one clock, so a rebuild, a
 * pause or a dropped frame changes nothing about what the fire is doing. The periods do
 * not share a factor, so the pattern does not visibly repeat.
 */
export function flameLevel(time: number): number {
  const flicker = Math.sin(time * 7.3) * 0.5 + Math.sin(time * 3.1 + 1.7) * 0.3 + Math.sin(time * 13.7 + 0.4) * 0.2;
  return 0.775 + flicker * 0.225;
}
