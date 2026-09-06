import type { StoryDialogueLine } from '@/story/types';

interface Props {
  lines: StoryDialogueLine[];
  onChange(lines: StoryDialogueLine[]): void;
}

export function DialogueEditor({ lines, onChange }: Props) {
  const update = (index: number, patch: Partial<StoryDialogueLine>) => onChange(lines.map((line, at) => at === index ? { ...line, ...patch } : line));
  return <fieldset><legend>Dialogue</legend>{lines.map((line, index) => <div className="dialogue-line" key={`${line.id}-${index}`}>
    <label>Line id <input value={line.id} onChange={(event) => update(index, { id: event.target.value })} /></label>
    <label>Speaker id <input value={line.speakerId} onChange={(event) => update(index, { speakerId: event.target.value })} /></label>
    <label>Text <textarea value={line.text} onChange={(event) => update(index, { text: event.target.value })} /></label>
    <button onClick={() => onChange(lines.filter((_, at) => at !== index))} type="button">Remove line</button>
    <button disabled={index === 0} onClick={() => { const next = [...lines]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }} type="button">Move line up</button>
  </div>)}<button onClick={() => onChange([...lines, { id: `line-${lines.length + 1}`, speakerId: 'speaker', text: 'New dialogue' }])} type="button">Add dialogue line</button></fieldset>;
}
