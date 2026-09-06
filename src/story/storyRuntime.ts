/**
 * The flag-store primitives underneath the story runtime.
 *
 * `parseStoryProject`/`validateStoryProject` are authoring-time only: they check that a
 * project is well-formed, they do not track which flags a play session has actually set.
 * This module is what does: a flag set, plus the operations that read and mutate it.
 *
 * It used to be the whole of item 11's placeholder runtime (see git history) — backlog
 * item 15 needed *something* that could hold "the player has been to the stable" as a
 * flag, ahead of a full runtime existing. Item 11's real runtime, `storyEngine.ts`,
 * absorbed the rest (trigger evaluation for all five `StoryTrigger` kinds, quest logging,
 * persistence) and now sits on top of these primitives rather than beside them. Both the
 * stable-quest and infinite-monkey-cage projects still use `createStoryRuntime`/
 * `hasFlag`/`applyEffect`/`beatIsUnlocked` directly (see tests/story/), so this file's
 * exports stay as they are.
 */
import type { StoryBeat, StoryEffect } from './types';

export interface StoryRuntimeState {
  flags: Set<string>;
}

export function createStoryRuntime(initialFlags: readonly string[] = []): StoryRuntimeState {
  return { flags: new Set(initialFlags) };
}

export function hasFlag(state: StoryRuntimeState, flag: string): boolean {
  return state.flags.has(flag);
}

export function setFlag(state: StoryRuntimeState, flag: string): void {
  state.flags.add(flag);
}

/** Applies one authored `StoryEffect`. Only `set-flag` mutates state; `dialogue` is left
 * for whatever is presenting it (the phone, a log view) to read and display. */
export function applyEffect(state: StoryRuntimeState, effect: StoryEffect): void {
  if (effect.kind === 'set-flag') setFlag(state, effect.flag);
}

/** A beat is unlocked once every flag it requires is set — the same rule a full runtime
 * would use to decide a beat is reachable, kept here so authored `requiredFlags` mean the
 * same thing whether or not a fuller engine exists yet. */
export function beatIsUnlocked(state: StoryRuntimeState, beat: StoryBeat): boolean {
  return beat.requiredFlags.every((flag) => hasFlag(state, flag));
}

/** Plain string array, safe to JSON.stringify into localStorage/save data. */
export function serializeFlags(state: StoryRuntimeState): string[] {
  return [...state.flags].sort();
}

export function loadFlags(flags: readonly string[]): StoryRuntimeState {
  return createStoryRuntime(flags);
}
