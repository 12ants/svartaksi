import { useState } from 'react';
import initialProject from '@/story/projects/svartaksi-opening.json';
import type { StoryBeat, StoryProject } from '@/story/types';
import { validateStoryProject } from '@/story/validateStoryProject';
import { openStoryProject, saveStoryProject, type StoryDocument } from './storyFileStore';
import { addBeat, addFlag, createStoryEditorState, duplicateBeat, moveBeat, removeBeat, removeFlag } from './storyEditorState';
import { StorySidebar } from './StorySidebar';
import { BeatEditor } from './BeatEditor';

export function StoryEditor() {
  const [document, setDocument] = useState<StoryDocument>({ project: initialProject as StoryProject });
  const [state, setState] = useState(() => createStoryEditorState(document.project));
  const [status, setStatus] = useState('');
  const validation = validateStoryProject(state.project);
  const selected = state.project.beats.find((beat) => beat.id === state.selectedBeatId);
  const apply = (next: typeof state) => { setState(next); setDocument((current) => ({ ...current, project: next.project })); };
  const updateBeat = (beat: StoryBeat) => apply({ ...state, project: { ...state.project, beats: state.project.beats.map((item) => item.id === state.selectedBeatId ? beat : item) }, selectedBeatId: beat.id });

  async function open() {
    const result = await openStoryProject();
    if (result.outcome === 'success') { setDocument(result.document); setState(createStoryEditorState(result.document.project)); setStatus(`Opened ${result.document.project.id}`); }
    else setStatus(result.outcome === 'cancelled' ? 'Open cancelled' : `Open failed: ${result.errors[0]?.message}`);
  }
  async function save(saveAs = false) {
    const result = await saveStoryProject({ ...document, project: state.project }, { saveAs });
    if (result.outcome === 'success') { setDocument(result.document); setStatus(`Story ${result.delivery}`); }
    else setStatus(result.outcome === 'cancelled' ? 'Save cancelled' : `Save failed: ${result.errors[0]?.message}`);
  }

  return <section aria-labelledby="story-editor-heading" className="author-panel">
    <header className="story-toolbar"><div><h2 id="story-editor-heading">Story Editor</h2><a href="/docs/story/">Markdown story references</a></div><button onClick={() => void open()} type="button">Open</button><button disabled={!validation.valid} onClick={() => void save()} type="button">Save</button><button disabled={!validation.valid} onClick={() => void save(true)} type="button">Save As</button></header>
    <div aria-live="polite" role="status">{status}</div>
    {!validation.valid && <ul aria-label="Validation errors" className="validation-errors">{validation.errors.map((error, index) => <li key={`${error.path}-${index}`}>{error.path}: {error.message}</li>)}</ul>}
    <div className="story-layout">
      <StorySidebar state={state} onSelect={(selectedBeatId) => apply({ ...state, selectedBeatId })} onAdd={() => apply(addBeat(state))} onDuplicate={(id) => apply(duplicateBeat(state, id))} onMove={(id, offset) => apply(moveBeat(state, id, offset))} onRemove={(id) => apply(removeBeat(state, id))} onAddFlag={(flag) => apply(addFlag(state, flag))} onRemoveFlag={(flag) => apply(removeFlag(state, flag))} />
      {selected ? <BeatEditor beat={selected} onChange={updateBeat} /> : <p>Select or add a beat.</p>}
    </div>
  </section>;
}
