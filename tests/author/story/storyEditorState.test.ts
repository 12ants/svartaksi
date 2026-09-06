import { addBeat, addDialogueLine, addFlag, createStoryEditorState, duplicateBeat, moveBeat, moveDialogueLine, removeBeat, removeDialogueLine, removeFlag } from '@/author/story/storyEditorState';
import type { StoryProject } from '@/story/types';

const project: StoryProject = { schemaVersion: 1, id: 'test', flags: ['a'], places: [], beats: [
  { id: 'one', title: 'One', trigger: { kind: 'manual' }, requiredFlags: [], effects: [{ kind: 'dialogue', lines: [{ id: 'line', speakerId: 'p', text: 'Hi' }] }] },
  { id: 'two', title: 'Two', trigger: { kind: 'manual' }, requiredFlags: [], effects: [] },
] };

describe('storyEditorState', () => {
  it('adds, duplicates, reorders, and removes beats with repaired selection', () => {
    let state = addBeat(createStoryEditorState(project));
    expect(state.selectedBeatId).toBe('new-beat');
    state = duplicateBeat(state, 'one');
    expect(state.selectedBeatId).toBe('one-copy');
    expect(state.project.beats[1].effects[0]).toMatchObject({ lines: [{ id: 'line-copy' }] });
    state = moveBeat(state, 'one-copy', 1);
    expect(state.project.beats[2].id).toBe('one-copy');
    state = removeBeat(state, 'one-copy');
    expect(state.selectedBeatId).toBe('new-beat');
  });

  it('adds and removes flags and dialogue lines', () => {
    let state = addFlag(createStoryEditorState(project), 'b');
    state = removeFlag(state, 'a');
    expect(state.project.flags).toEqual(['b']);
    const effect = project.beats[0].effects[0];
    if (effect.kind !== 'dialogue') throw new Error('fixture');
    const added = addDialogueLine(effect, ['line']);
    if (added.kind !== 'dialogue') throw new Error('fixture');
    expect(moveDialogueLine(added, 'new-line', -1).lines[0].id).toBe('new-line');
    expect(removeDialogueLine(added, 'line')).toMatchObject({ lines: [{ id: 'new-line' }] });
  });
});
