import { describe, expect, it } from 'vitest';

import {
  createStoryEngine,
  loadStoryEngine,
  loadStoryEngineFromStorage,
  saveStoryEngineToStorage,
  serializeStoryEngine,
  stepStoryEngine,
  STORY_ENGINE_STORAGE_KEY,
} from '../../src/story/storyEngine';
import { hasFlag } from '../../src/story/storyRuntime';
import type { StoryProject } from '../../src/story/types';

const manualProject: StoryProject = {
  schemaVersion: 1,
  id: 'manual-project',
  flags: ['manual:done'],
  places: [],
  beats: [
    {
      id: 'do-the-thing',
      title: 'Do the thing',
      trigger: { kind: 'manual' },
      requiredFlags: [],
      effects: [{ kind: 'set-flag', flag: 'manual:done' }],
    },
  ],
};

const routeProject: StoryProject = {
  schemaVersion: 1,
  id: 'route-project',
  flags: ['route:reached'],
  places: [],
  beats: [
    {
      id: 'reach-midpoint',
      title: 'Reach the midpoint',
      trigger: { kind: 'route-progress', routeId: 'opening-ride', progress: 0.5 },
      requiredFlags: [],
      effects: [{ kind: 'set-flag', flag: 'route:reached' }],
    },
  ],
};

const placeProject: StoryProject = {
  schemaVersion: 1,
  id: 'place-project',
  flags: ['place:visited'],
  places: [{ id: 'somewhere', label: 'Somewhere' }],
  beats: [
    {
      id: 'visit-somewhere',
      title: 'Visit somewhere',
      trigger: { kind: 'near-place', placeId: 'somewhere', radiusMeters: 10 },
      requiredFlags: [],
      effects: [{ kind: 'set-flag', flag: 'place:visited' }],
    },
  ],
};

const interactionProject: StoryProject = {
  schemaVersion: 1,
  id: 'interaction-project',
  flags: ['interaction:done'],
  places: [],
  beats: [
    {
      id: 'click-thing',
      title: 'Click the thing',
      trigger: { kind: 'interaction', targetId: 'the-thing' },
      requiredFlags: [],
      effects: [{ kind: 'set-flag', flag: 'interaction:done' }],
    },
  ],
};

const phoneProject: StoryProject = {
  schemaVersion: 1,
  id: 'phone-project',
  flags: ['phone:received'],
  places: [],
  beats: [
    {
      id: 'receive-text',
      title: 'Receive the text',
      trigger: { kind: 'phone-message', messageId: 'the-text' },
      requiredFlags: [],
      effects: [{ kind: 'set-flag', flag: 'phone:received' }],
    },
  ],
};

const gatedProject: StoryProject = {
  schemaVersion: 1,
  id: 'gated-project',
  flags: ['gate:opened', 'gate:done'],
  places: [],
  beats: [
    {
      id: 'open-gate',
      title: 'Open the gate',
      trigger: { kind: 'manual' },
      requiredFlags: [],
      effects: [{ kind: 'set-flag', flag: 'gate:opened' }],
    },
    {
      id: 'finish-gate',
      title: 'Finish the gate',
      trigger: { kind: 'manual' },
      requiredFlags: ['gate:opened'],
      effects: [{ kind: 'set-flag', flag: 'gate:done' }],
    },
  ],
};

describe('story engine trigger evaluation', () => {
  it('fires a manual trigger only when its beat id is explicitly given', () => {
    const state = createStoryEngine();
    const missed = stepStoryEngine(state, [manualProject], { at: 0 });
    expect(missed.unlocked).toEqual([]);

    const hit = stepStoryEngine(state, [manualProject], { at: 1, manualBeatIds: ['do-the-thing'] });
    expect(hit.unlocked).toHaveLength(1);
    expect(hasFlag(state.runtime, 'manual:done')).toBe(true);
  });

  it('fires a route-progress trigger once progress reaches the authored threshold', () => {
    const state = createStoryEngine();
    stepStoryEngine(state, [routeProject], { at: 0, routeProgress: { 'opening-ride': 0.2 } });
    expect(hasFlag(state.runtime, 'route:reached')).toBe(false);

    stepStoryEngine(state, [routeProject], { at: 1, routeProgress: { 'opening-ride': 0.5 } });
    expect(hasFlag(state.runtime, 'route:reached')).toBe(true);
  });

  it('fires a near-place trigger once the player is within the authored radius', () => {
    const state = createStoryEngine();
    const resolvePlace = () => ({ x: 100, z: 100 });
    stepStoryEngine(state, [placeProject], { at: 0, playerPosition: { x: 0, z: 0 }, resolvePlace });
    expect(hasFlag(state.runtime, 'place:visited')).toBe(false);

    stepStoryEngine(state, [placeProject], { at: 1, playerPosition: { x: 105, z: 100 }, resolvePlace });
    expect(hasFlag(state.runtime, 'place:visited')).toBe(true);
  });

  it('fires an interaction trigger when its target id is given', () => {
    const state = createStoryEngine();
    stepStoryEngine(state, [interactionProject], { at: 0, interactionTargetIds: ['something-else'] });
    expect(hasFlag(state.runtime, 'interaction:done')).toBe(false);

    stepStoryEngine(state, [interactionProject], { at: 1, interactionTargetIds: ['the-thing'] });
    expect(hasFlag(state.runtime, 'interaction:done')).toBe(true);
  });

  it('fires a phone-message trigger when a matching message id arrives', () => {
    const state = createStoryEngine();
    stepStoryEngine(state, [phoneProject], { at: 0, phoneMessageIds: ['some-other-text'] });
    expect(hasFlag(state.runtime, 'phone:received')).toBe(false);

    stepStoryEngine(state, [phoneProject], { at: 1, phoneMessageIds: ['the-text'] });
    expect(hasFlag(state.runtime, 'phone:received')).toBe(true);
  });

  it('never fires the same beat twice, even if its trigger stays true', () => {
    const state = createStoryEngine();
    const resolvePlace = () => ({ x: 0, z: 0 });
    const first = stepStoryEngine(state, [placeProject], { at: 0, playerPosition: { x: 0, z: 0 }, resolvePlace });
    const second = stepStoryEngine(state, [placeProject], { at: 1, playerPosition: { x: 0, z: 0 }, resolvePlace });
    expect(first.unlocked).toHaveLength(1);
    expect(second.unlocked).toHaveLength(0);
    expect(state.questLog).toHaveLength(1);
  });

  it('respects requiredFlags, chaining within a step once the gate flag is set', () => {
    const state = createStoryEngine();
    // finish-gate requires gate:opened, which open-gate's own effect sets earlier in the
    // same step (beats are evaluated in authored order) — so both fire in one step.
    const first = stepStoryEngine(state, [gatedProject], { at: 0, manualBeatIds: ['open-gate', 'finish-gate'] });
    expect(first.unlocked.map((u) => u.beat.id)).toEqual(['open-gate', 'finish-gate']);

    const second = stepStoryEngine(state, [gatedProject], { at: 1, manualBeatIds: ['open-gate', 'finish-gate'] });
    expect(second.unlocked).toEqual([]);
  });

  it('withholds a gated beat until its required flag is actually set', () => {
    const state = createStoryEngine();
    const attempt = stepStoryEngine(state, [gatedProject], { at: 0, manualBeatIds: ['finish-gate'] });
    expect(attempt.unlocked).toEqual([]);
  });

  it('logs a quest log entry keyed by project id and beat id', () => {
    const state = createStoryEngine();
    stepStoryEngine(state, [phoneProject], { at: 42, phoneMessageIds: ['the-text'] });
    expect(state.questLog).toEqual([
      { projectId: 'phone-project', beatId: 'receive-text', title: 'Receive the text', description: undefined, at: 42 },
    ]);
  });
});

describe('story engine persistence', () => {
  it('round-trips flags, fired beats and the quest log through serialize/load', () => {
    const state = createStoryEngine();
    stepStoryEngine(state, [phoneProject], { at: 1, phoneMessageIds: ['the-text'] });

    const serialized = serializeStoryEngine(state);
    const reloaded = loadStoryEngine(serialized);

    expect(hasFlag(reloaded.runtime, 'phone:received')).toBe(true);
    expect(reloaded.fired.has('phone-project:receive-text')).toBe(true);
    expect(reloaded.questLog).toEqual(state.questLog);

    // And the reloaded engine still refuses to re-fire the same beat.
    const step = stepStoryEngine(reloaded, [phoneProject], { at: 2, phoneMessageIds: ['the-text'] });
    expect(step.unlocked).toEqual([]);
  });

  it('survives a reload through localStorage-shaped storage', () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value); },
    };

    const state = createStoryEngine();
    stepStoryEngine(state, [phoneProject], { at: 1, phoneMessageIds: ['the-text'] });
    saveStoryEngineToStorage(storage, state);

    expect(backing.has(STORY_ENGINE_STORAGE_KEY)).toBe(true);

    const reloaded = loadStoryEngineFromStorage(storage);
    expect(hasFlag(reloaded.runtime, 'phone:received')).toBe(true);
    expect(reloaded.questLog).toHaveLength(1);
  });

  it('starts fresh rather than crashing on a missing or corrupt snapshot', () => {
    const empty = loadStoryEngineFromStorage({ getItem: () => null });
    expect(empty.questLog).toEqual([]);

    const corrupt = loadStoryEngineFromStorage({ getItem: () => '{not json' });
    expect(corrupt.questLog).toEqual([]);
  });
});
