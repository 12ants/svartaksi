import type { StoryBeat, StoryDialogueLine, StoryEffect, StoryProject } from '@/story/types';

export interface StoryEditorState {
  project: StoryProject;
  selectedBeatId: string | null;
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

export function createStoryEditorState(project: StoryProject): StoryEditorState {
  return { project, selectedBeatId: project.beats[0]?.id ?? null };
}

export function addBeat(state: StoryEditorState): StoryEditorState {
  const id = uniqueId('new-beat', new Set(state.project.beats.map((beat) => beat.id)));
  const beat: StoryBeat = { id, title: 'New beat', trigger: { kind: 'manual' }, requiredFlags: [], effects: [] };
  return { project: { ...state.project, beats: [...state.project.beats, beat] }, selectedBeatId: id };
}

export function duplicateBeat(state: StoryEditorState, id: string): StoryEditorState {
  const source = state.project.beats.find((beat) => beat.id === id);
  if (!source) return state;
  const beatId = uniqueId(`${source.id}-copy`, new Set(state.project.beats.map((beat) => beat.id)));
  const lineIds = new Set(state.project.beats.flatMap((beat) => beat.effects.flatMap((effect) => effect.kind === 'dialogue' ? effect.lines.map((line) => line.id) : [])));
  const effects: StoryEffect[] = source.effects.map((effect) => effect.kind === 'set-flag' ? { ...effect } : ({
    ...effect,
    lines: effect.lines.map((line) => ({ ...line, id: uniqueId(`${line.id}-copy`, lineIds) })).map((line) => { lineIds.add(line.id); return line; }),
  }));
  const copy = { ...source, id: beatId, title: `${source.title} copy`, requiredFlags: [...source.requiredFlags], effects };
  const at = state.project.beats.indexOf(source) + 1;
  const beats = [...state.project.beats]; beats.splice(at, 0, copy);
  return { project: { ...state.project, beats }, selectedBeatId: beatId };
}

export function moveBeat(state: StoryEditorState, id: string, offset: -1 | 1): StoryEditorState {
  const from = state.project.beats.findIndex((beat) => beat.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= state.project.beats.length) return state;
  const beats = [...state.project.beats]; [beats[from], beats[to]] = [beats[to], beats[from]];
  return { ...state, project: { ...state.project, beats } };
}

export function removeBeat(state: StoryEditorState, id: string): StoryEditorState {
  const index = state.project.beats.findIndex((beat) => beat.id === id);
  if (index < 0) return state;
  const beats = state.project.beats.filter((beat) => beat.id !== id);
  const selectedBeatId = state.selectedBeatId === id ? (beats[Math.min(index, beats.length - 1)]?.id ?? null) : state.selectedBeatId;
  return { project: { ...state.project, beats }, selectedBeatId };
}

export function addFlag(state: StoryEditorState, flag: string): StoryEditorState {
  return !flag.trim() || state.project.flags.includes(flag) ? state : { ...state, project: { ...state.project, flags: [...state.project.flags, flag] } };
}

export function removeFlag(state: StoryEditorState, flag: string): StoryEditorState {
  return { ...state, project: { ...state.project, flags: state.project.flags.filter((item) => item !== flag) } };
}

export function addDialogueLine(effect: Extract<StoryEffect, { kind: 'dialogue' }>, usedIds: string[]): StoryEffect {
  const line: StoryDialogueLine = { id: uniqueId('new-line', new Set(usedIds)), speakerId: 'speaker', text: 'New dialogue' };
  return { ...effect, lines: [...effect.lines, line] };
}

export function removeDialogueLine(effect: Extract<StoryEffect, { kind: 'dialogue' }>, id: string): StoryEffect {
  return { ...effect, lines: effect.lines.filter((line) => line.id !== id) };
}

export function moveDialogueLine(effect: Extract<StoryEffect, { kind: 'dialogue' }>, id: string, offset: -1 | 1): StoryEffect {
  const from = effect.lines.findIndex((line) => line.id === id); const to = from + offset;
  if (from < 0 || to < 0 || to >= effect.lines.length) return effect;
  const lines = [...effect.lines]; [lines[from], lines[to]] = [lines[to], lines[from]];
  return { ...effect, lines };
}
