/**
 * The real item 11 story runtime: evaluates authored `StoryProject`s against live game
 * state (player position, route progress, an arriving phone message, an explicit
 * manual/interaction call) and produces a quest log the phone can show.
 *
 * `storyRuntime.ts` is the stopgap this absorbs: its flag-set primitives
 * (`createStoryRuntime`/`hasFlag`/`setFlag`/`applyEffect`/`beatIsUnlocked`) are reused
 * here rather than duplicated, because backlog item 15's stable-quest project and the
 * infinite_monkey_cage project already play through end to end against them and there is
 * no reason to give either project a second flag store. What this module adds on top is
 * everything the stopgap's header said was still missing: evaluating all five
 * `StoryTrigger` kinds (not just "call applyEffect by hand"), tracking which beats have
 * already fired (so a still-true trigger does not re-log the same quest every tick), and
 * a quest log a UI can render and persist.
 *
 * Pure and WebGL-free on purpose, in the same spirit as `phone.ts` and `bonfireCamp.ts`:
 * inputs are plain data, so a test can drive a whole quest without a renderer.
 */
import {
  applyEffect,
  beatIsUnlocked,
  createStoryRuntime,
  loadFlags,
  serializeFlags,
  type StoryRuntimeState,
} from './storyRuntime';
import type { StoryBeat, StoryProject, StoryTrigger } from './types';

/** One line of the phone's quest log: an unlocked beat, keyed the way the backlog asks
 * ("keyed by story project and trigger id") so two projects can safely reuse a beat id. */
export interface QuestLogEntry {
  projectId: string;
  beatId: string;
  title: string;
  description?: string;
  /** World-clock seconds the beat unlocked, for ordering — same clock phone.ts uses. */
  at: number;
}

export interface StoryEngineState {
  runtime: StoryRuntimeState;
  /** `${projectId}:${beatId}` of every beat that has already fired, so a trigger that
   * stays true (near-place while standing still, an interaction target still clickable)
   * unlocks its beat exactly once. */
  fired: Set<string>;
  questLog: QuestLogEntry[];
}

/** Everything a tick can tell the engine about the world. Every field is optional: a
 * caller evaluating just the phone-message triggers has no reason to also supply a
 * player position, and an engine step with nothing new simply unlocks nothing. */
export interface StoryEngineInput {
  /** World-clock seconds this step happens at, stamped onto any quest log entries it
   * creates. */
  at: number;
  /** Beat ids to fire unconditionally this step — `manual` triggers, and the near-place/
   * interaction cases where the caller already knows which target was hit. */
  manualBeatIds?: readonly string[];
  /** Interaction target ids clicked/activated this step. */
  interactionTargetIds?: readonly string[];
  /** The player's local position, for `near-place` triggers. */
  playerPosition?: { x: number; z: number } | null;
  /** routeId -> progress in [0,1], for `route-progress` triggers. A beat fires once
   * progress has reached at least the authored threshold. */
  routeProgress?: Readonly<Record<string, number>>;
  /** Ids of `PhoneMessage`s that landed in the inbox this step, for `phone-message`
   * triggers. */
  phoneMessageIds?: readonly string[];
  /** Resolves an authored place id to a local position, for `near-place` triggers.
   * Kept out of the `StoryProject` itself — a place id is an authoring-time label, and
   * only the runtime (which already knows real-world coordinates like the bonfire's,
   * see bonfireCamp.ts) knows where it actually is. */
  resolvePlace?: (placeId: string) => { x: number; z: number } | null;
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function triggerFires(trigger: StoryTrigger, input: StoryEngineInput): boolean {
  switch (trigger.kind) {
    case 'manual':
      return false; // matched by beat id in stepStoryEngine, not here
    case 'route-progress': {
      const progress = input.routeProgress?.[trigger.routeId];
      return progress !== undefined && progress >= trigger.progress;
    }
    case 'near-place': {
      if (!input.playerPosition || !input.resolvePlace) return false;
      const place = input.resolvePlace(trigger.placeId);
      if (!place) return false;
      return distance(input.playerPosition, place) <= trigger.radiusMeters;
    }
    case 'interaction':
      return (input.interactionTargetIds ?? []).includes(trigger.targetId);
    case 'phone-message':
      return (input.phoneMessageIds ?? []).includes(trigger.messageId);
    default:
      return false;
  }
}

export function createStoryEngine(initial?: {
  flags?: readonly string[];
  fired?: readonly string[];
  questLog?: readonly QuestLogEntry[];
}): StoryEngineState {
  return {
    runtime: createStoryRuntime(initial?.flags ?? []),
    fired: new Set(initial?.fired ?? []),
    questLog: initial?.questLog ? [...initial.questLog] : [],
  };
}

/**
 * Evaluates every beat of every given project against one tick of input, applies the
 * effects of whichever newly fire, and returns which beats unlocked this step (so a
 * caller can e.g. surface their dialogue). Mutates `state` in place — same convention as
 * `applyEffect`/`setFlag` in storyRuntime.ts — and also returns it for chaining.
 */
export function stepStoryEngine(
  state: StoryEngineState,
  projects: readonly StoryProject[],
  input: StoryEngineInput,
): { state: StoryEngineState; unlocked: Array<{ project: StoryProject; beat: StoryBeat }> } {
  const unlocked: Array<{ project: StoryProject; beat: StoryBeat }> = [];
  for (const project of projects) {
    for (const beat of project.beats) {
      const key = `${project.id}:${beat.id}`;
      if (state.fired.has(key)) continue;
      if (!beatIsUnlocked(state.runtime, beat)) continue;

      const manual = beat.trigger.kind === 'manual' && (input.manualBeatIds ?? []).includes(beat.id);
      const fires = manual || triggerFires(beat.trigger, input);
      if (!fires) continue;

      state.fired.add(key);
      for (const effect of beat.effects) applyEffect(state.runtime, effect);
      state.questLog.push({
        projectId: project.id,
        beatId: beat.id,
        title: beat.title,
        description: beat.description,
        at: input.at,
      });
      unlocked.push({ project, beat });
    }
  }
  return { state, unlocked };
}

/** Plain, JSON-safe snapshot of engine state — flags, fired beats, and the quest log —
 * for localStorage the same way `serializeFlags` already covers just the flags. */
export interface SerializedStoryEngine {
  flags: string[];
  fired: string[];
  questLog: QuestLogEntry[];
}

export function serializeStoryEngine(state: StoryEngineState): SerializedStoryEngine {
  return {
    flags: serializeFlags(state.runtime),
    fired: [...state.fired].sort(),
    questLog: [...state.questLog],
  };
}

export function loadStoryEngine(serialized: SerializedStoryEngine): StoryEngineState {
  return {
    runtime: loadFlags(serialized.flags),
    fired: new Set(serialized.fired),
    questLog: [...serialized.questLog],
  };
}

/** localStorage key the engine's snapshot lives under — registered with
 * `SVARTAKSI_STORAGE_KEYS` in resetGame.ts so "reset all settings" clears quest progress
 * along with everything else Svartaksi owns. */
export const STORY_ENGINE_STORAGE_KEY = 'svartaksi.story.v1';

/** Reads a previously-saved snapshot, or a fresh engine if there is none or it is
 * corrupt — a broken save should start the story over, not crash the app. */
export function loadStoryEngineFromStorage(storage: Pick<Storage, 'getItem'>): StoryEngineState {
  try {
    const raw = storage.getItem(STORY_ENGINE_STORAGE_KEY);
    if (!raw) return createStoryEngine();
    const parsed = JSON.parse(raw) as Partial<SerializedStoryEngine>;
    return loadStoryEngine({
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      fired: Array.isArray(parsed.fired) ? parsed.fired : [],
      questLog: Array.isArray(parsed.questLog) ? parsed.questLog : [],
    });
  } catch {
    return createStoryEngine();
  }
}

export function saveStoryEngineToStorage(storage: Pick<Storage, 'setItem'>, state: StoryEngineState): void {
  storage.setItem(STORY_ENGINE_STORAGE_KEY, JSON.stringify(serializeStoryEngine(state)));
}
