import { describe, expect, it } from 'vitest';

import {
  applyEffect,
  beatIsUnlocked,
  createStoryRuntime,
  hasFlag,
  loadFlags,
  serializeFlags,
  setFlag,
} from '../../src/story/storyRuntime';
import type { StoryBeat } from '../../src/story/types';

/**
 * Backlog item 15 needs a tranquilizer that is a story flag, not an inventory item —
 * item 11's story runtime is only an authoring/validation schema today (parseStoryProject,
 * validateStoryProject), with no flag store. This is that minimal store: small and scoped
 * to what item 15 needs (set/query flags, evaluate a beat's requiredFlags, persist across
 * reload as plain JSON), not a full quest engine.
 */
describe('storyRuntime', () => {
  it('starts with no flags set', () => {
    const state = createStoryRuntime();
    expect(hasFlag(state, 'stable-visited')).toBe(false);
  });

  it('accepts initial flags', () => {
    const state = createStoryRuntime(['stable-visited']);
    expect(hasFlag(state, 'stable-visited')).toBe(true);
    expect(hasFlag(state, 'tranquilizer-taken')).toBe(false);
  });

  it('sets a flag and it stays set', () => {
    const state = createStoryRuntime();
    setFlag(state, 'stable-visited');
    expect(hasFlag(state, 'stable-visited')).toBe(true);
  });

  it('setting the same flag twice is idempotent', () => {
    const state = createStoryRuntime();
    setFlag(state, 'stable-visited');
    setFlag(state, 'stable-visited');
    expect(serializeFlags(state)).toEqual(['stable-visited']);
  });

  it('applies a set-flag effect', () => {
    const state = createStoryRuntime();
    applyEffect(state, { kind: 'set-flag', flag: 'tranquilizer-taken' });
    expect(hasFlag(state, 'tranquilizer-taken')).toBe(true);
  });

  it('a dialogue effect does not touch flags', () => {
    const state = createStoryRuntime();
    applyEffect(state, { kind: 'dialogue', lines: [{ id: 'l1', speakerId: 'npc', text: 'hi' }] });
    expect(serializeFlags(state)).toEqual([]);
  });

  it('a beat with no required flags is always unlocked', () => {
    const beat: StoryBeat = {
      id: 'b1', title: 'Find the stable',
      trigger: { kind: 'manual' }, requiredFlags: [], effects: [],
    };
    expect(beatIsUnlocked(createStoryRuntime(), beat)).toBe(true);
  });

  it('a beat is locked until every required flag is set', () => {
    const beat: StoryBeat = {
      id: 'b2', title: 'Take the tranquilizer',
      trigger: { kind: 'manual' }, requiredFlags: ['stable-visited'], effects: [],
    };
    const state = createStoryRuntime();
    expect(beatIsUnlocked(state, beat)).toBe(false);
    setFlag(state, 'stable-visited');
    expect(beatIsUnlocked(state, beat)).toBe(true);
  });

  it('a beat requiring several flags needs all of them', () => {
    const beat: StoryBeat = {
      id: 'b3', title: 'Ride the horse',
      trigger: { kind: 'manual' }, requiredFlags: ['stable-visited', 'tranquilizer-taken'], effects: [],
    };
    const state = createStoryRuntime(['stable-visited']);
    expect(beatIsUnlocked(state, beat)).toBe(false);
    setFlag(state, 'tranquilizer-taken');
    expect(beatIsUnlocked(state, beat)).toBe(true);
  });

  it('round-trips through serialize/load for persistence across a reload', () => {
    const state = createStoryRuntime();
    setFlag(state, 'stable-visited');
    setFlag(state, 'tranquilizer-taken');
    const restored = loadFlags(serializeFlags(state));
    expect(hasFlag(restored, 'stable-visited')).toBe(true);
    expect(hasFlag(restored, 'tranquilizer-taken')).toBe(true);
    expect(hasFlag(restored, 'anything-else')).toBe(false);
  });
});
