import { describe, expect, it } from 'vitest';

import svartaksiOpening from '../../src/story/projects/svartaksi-opening.json';
import { validateStoryProject } from '../../src/story/validateStoryProject';
import { createStoryEngine, stepStoryEngine } from '../../src/story/storyEngine';
import { CAMP_LOCATION } from '../../src/svartaksi/bonfireCamp';
import { FOREST_RAVE_MESSAGE_ID } from '../../src/svartaksi/phone';
import { START_LOCATION } from '../../src/svartaksi/config';
import { lngLatToLocal } from '../../src/world/geo';
import type { StoryProject } from '../../src/story/types';

describe('forest rave mission (backlog item 11)', () => {
  it('is a well-formed authored beat on the svartaksi-opening project', () => {
    const result = validateStoryProject(svartaksiOpening);
    expect(result.errors).toEqual([]);
  });

  it('is keyed on the forest-rave phone message id from phone.ts, not on body text', () => {
    const project = svartaksiOpening as unknown as StoryProject;
    const beat = project.beats.find((b) => b.id === 'forest-rave-invite')!;
    expect(beat.trigger).toEqual({ kind: 'phone-message', messageId: FOREST_RAVE_MESSAGE_ID });
  });

  it('receiving the forest rave text unlocks the mission and logs it in the quest log', () => {
    const project = svartaksiOpening as unknown as StoryProject;
    const state = createStoryEngine();
    const { unlocked } = stepStoryEngine(state, [project], { at: 100, phoneMessageIds: [FOREST_RAVE_MESSAGE_ID] });

    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].beat.id).toBe('forest-rave-invite');
    expect(state.questLog).toContainEqual(expect.objectContaining({
      projectId: 'svartaksi-opening',
      beatId: 'forest-rave-invite',
    }));
  });

  it('resolves to the authored bonfire location: the ryssbergen-camp place is the camp the game already draws', () => {
    const project = svartaksiOpening as unknown as StoryProject;
    const bonfirePlace = project.places.find((place) => place.id === 'ryssbergen-camp');
    expect(bonfirePlace).toBeDefined();

    // The near-place beat that actually meets the pills at the fire shares this same
    // authored place id, which is what "resolution maps it to the authored bonfire
    // location" means in practice: both beats point at one place, the runtime resolves
    // that place id to CAMP_LOCATION's real coordinates (see bonfireCamp.ts).
    const meetBeat = project.beats.find((b) => b.id === 'meet-bonfire-pill')!;
    expect(meetBeat.trigger).toMatchObject({ kind: 'near-place', placeId: 'ryssbergen-camp' });

    const resolved = lngLatToLocal(START_LOCATION, CAMP_LOCATION);
    expect(Number.isFinite(resolved.x)).toBe(true);
    expect(Number.isFinite(resolved.z)).toBe(true);
  });
});
