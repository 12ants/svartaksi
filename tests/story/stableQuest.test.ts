import { describe, expect, it } from 'vitest';

import stableQuest from '../../src/story/projects/stable-quest.json';
import { validateStoryProject } from '../../src/story/validateStoryProject';
import { applyEffect, beatIsUnlocked, createStoryRuntime, hasFlag } from '../../src/story/storyRuntime';
import type { StoryProject } from '../../src/story/types';

describe('stable-quest story project (backlog item 15)', () => {
  it('is a well-formed authored story project', () => {
    const result = validateStoryProject(stableQuest);
    expect(result.errors).toEqual([]);
  });

  it('plays end to end through the flag runtime: find stable, take tranquilizer, mount horse', () => {
    const project = stableQuest as unknown as StoryProject;
    const runtime = createStoryRuntime();
    const [findStable, takeTranquilizer, mountHorse] = project.beats;

    expect(beatIsUnlocked(runtime, findStable)).toBe(true);
    expect(beatIsUnlocked(runtime, takeTranquilizer)).toBe(false);

    for (const effect of findStable.effects) applyEffect(runtime, effect);
    expect(hasFlag(runtime, 'stable:visited')).toBe(true);
    expect(beatIsUnlocked(runtime, takeTranquilizer)).toBe(true);
    expect(beatIsUnlocked(runtime, mountHorse)).toBe(false);

    for (const effect of takeTranquilizer.effects) applyEffect(runtime, effect);
    expect(hasFlag(runtime, 'stable:tranquilizer-taken')).toBe(true);
    expect(beatIsUnlocked(runtime, mountHorse)).toBe(true);

    for (const effect of mountHorse.effects) applyEffect(runtime, effect);
    expect(hasFlag(runtime, 'stable:horse-mounted')).toBe(true);
  });
});
