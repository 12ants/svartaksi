import type { StoryEditorState } from './storyEditorState';

interface Props {
  state: StoryEditorState;
  onSelect(id: string): void;
  onAdd(): void;
  onDuplicate(id: string): void;
  onMove(id: string, offset: -1 | 1): void;
  onRemove(id: string): void;
  onAddFlag(flag: string): void;
  onRemoveFlag(flag: string): void;
}

export function StorySidebar(props: Props) {
  return (
    <aside className="story-sidebar">
      <h3>Beats</h3>
      <button onClick={props.onAdd} type="button">Add beat</button>
      <ol>
        {props.state.project.beats.map((beat, index) => (
          <li key={beat.id}>
            <button aria-current={props.state.selectedBeatId === beat.id ? 'true' : undefined} onClick={() => props.onSelect(beat.id)} type="button">{beat.title}</button>
            <button aria-label={`Move ${beat.title} up`} disabled={index === 0} onClick={() => props.onMove(beat.id, -1)} type="button">↑</button>
            <button aria-label={`Move ${beat.title} down`} disabled={index === props.state.project.beats.length - 1} onClick={() => props.onMove(beat.id, 1)} type="button">↓</button>
            <button aria-label={`Duplicate ${beat.title}`} onClick={() => props.onDuplicate(beat.id)} type="button">Copy</button>
            <button aria-label={`Remove ${beat.title}`} onClick={() => props.onRemove(beat.id)} type="button">Remove</button>
          </li>
        ))}
      </ol>
      <h3>Flags</h3>
      <ul>{props.state.project.flags.map((flag) => <li key={flag}>{flag} <button aria-label={`Remove flag ${flag}`} onClick={() => props.onRemoveFlag(flag)} type="button">Remove</button></li>)}</ul>
      <form onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('flag') as HTMLInputElement; props.onAddFlag(input.value); input.value = ''; }}>
        <label>New flag <input name="flag" /></label>
        <button type="submit">Add flag</button>
      </form>
    </aside>
  );
}
