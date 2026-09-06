import { describe, expect, it } from 'vitest';

import monkeyCage from '../../src/story/projects/infinite-monkey-cage.json';
import { validateStoryProject } from '../../src/story/validateStoryProject';
import { applyEffect, beatIsUnlocked, createStoryRuntime, hasFlag } from '../../src/story/storyRuntime';
import type { StoryProject } from '../../src/story/types';

describe('infinite-monkey-cage story project', () => {
  it('is a well-formed authored story project', () => {
    const result = validateStoryProject(monkeyCage);
    expect(result.errors).toEqual([]);
  });

  it('is triggered by the reveal phone message, not by body text', () => {
    const project = monkeyCage as unknown as StoryProject;
    const [receiveReveal] = project.beats;
    expect(receiveReveal.trigger).toEqual({ kind: 'phone-message', messageId: 'monkey-cage-reveal' });
  });

  it('sets monkey-cage:contacted through the shared flag runtime', () => {
    const project = monkeyCage as unknown as StoryProject;
    const runtime = createStoryRuntime();
    const [receiveReveal] = project.beats;

    expect(beatIsUnlocked(runtime, receiveReveal)).toBe(true);
    expect(hasFlag(runtime, 'monkey-cage:contacted')).toBe(false);

    for (const effect of receiveReveal.effects) applyEffect(runtime, effect);
    expect(hasFlag(runtime, 'monkey-cage:contacted')).toBe(true);
  });
});
