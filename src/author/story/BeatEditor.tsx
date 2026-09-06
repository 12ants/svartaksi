import type { StoryBeat, StoryEffect, StoryTrigger } from '@/story/types';
import { DialogueEditor } from './DialogueEditor';

export function BeatEditor({ beat, onChange }: { beat: StoryBeat; onChange(beat: StoryBeat): void }) {
  const updateTrigger = (patch: Partial<StoryTrigger>) => onChange({ ...beat, trigger: { ...beat.trigger, ...patch } as StoryTrigger });
  const setTriggerKind = (kind: StoryTrigger['kind']) => {
    const trigger: StoryTrigger = kind === 'manual' ? { kind } : kind === 'route-progress' ? { kind, routeId: '', progress: 0 } : kind === 'near-place' ? { kind, placeId: '', radiusMeters: 6 } : kind === 'interaction' ? { kind, targetId: '' } : { kind, messageId: '' };
    onChange({ ...beat, trigger });
  };
  const updateEffect = (index: number, effect: StoryEffect) => onChange({ ...beat, effects: beat.effects.map((item, at) => at === index ? effect : item) });
  return <div className="beat-editor">
    <label>Beat id <input value={beat.id} onChange={(event) => onChange({ ...beat, id: event.target.value })} /></label>
    <label>Title <input value={beat.title} onChange={(event) => onChange({ ...beat, title: event.target.value })} /></label>
    <label>Description <textarea value={beat.description ?? ''} onChange={(event) => onChange({ ...beat, description: event.target.value || undefined })} /></label>
    <label>Trigger <select value={beat.trigger.kind} onChange={(event) => setTriggerKind(event.target.value as StoryTrigger['kind'])}><option value="manual">Manual</option><option value="route-progress">Route progress</option><option value="near-place">Near place</option><option value="interaction">Interaction</option><option value="phone-message">Phone message</option></select></label>
    {beat.trigger.kind === 'route-progress' && <><label>Route id <input value={beat.trigger.routeId} onChange={(event) => updateTrigger({ routeId: event.target.value })} /></label><label>Route progress <input max="1" min="0" step="0.01" type="number" value={beat.trigger.progress} onChange={(event) => updateTrigger({ progress: Number(event.target.value) })} /></label></>}
    {beat.trigger.kind === 'near-place' && <><label>Place id <input value={beat.trigger.placeId} onChange={(event) => updateTrigger({ placeId: event.target.value })} /></label><label>Radius metres <input min="0" type="number" value={beat.trigger.radiusMeters} onChange={(event) => updateTrigger({ radiusMeters: Number(event.target.value) })} /></label></>}
    {beat.trigger.kind === 'interaction' && <label>Target id <input value={beat.trigger.targetId} onChange={(event) => updateTrigger({ targetId: event.target.value })} /></label>}
    {beat.trigger.kind === 'phone-message' && <label>Message id <input value={beat.trigger.messageId} onChange={(event) => updateTrigger({ messageId: event.target.value })} /></label>}
    <label>Required flags <input value={beat.requiredFlags.join(', ')} onChange={(event) => onChange({ ...beat, requiredFlags: event.target.value.split(',').map((flag) => flag.trim()).filter(Boolean) })} /></label>
    <h4>Effects</h4>
    {beat.effects.map((effect, index) => <div className="story-effect" key={index}>
      {effect.kind === 'set-flag' ? <label>Set flag <input value={effect.flag} onChange={(event) => updateEffect(index, { kind: 'set-flag', flag: event.target.value })} /></label> : <DialogueEditor lines={effect.lines} onChange={(lines) => updateEffect(index, { kind: 'dialogue', lines })} />}
      <button onClick={() => onChange({ ...beat, effects: beat.effects.filter((_, at) => at !== index) })} type="button">Remove effect</button>
    </div>)}
    <button onClick={() => onChange({ ...beat, effects: [...beat.effects, { kind: 'set-flag', flag: '' }] })} type="button">Add flag effect</button>
    <button onClick={() => onChange({ ...beat, effects: [...beat.effects, { kind: 'dialogue', lines: [] }] })} type="button">Add dialogue effect</button>
  </div>;
}
