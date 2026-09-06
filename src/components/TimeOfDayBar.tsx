import { formatClock } from '../svartaksi/formatClock';

/**
 * Time of day, on the main screen rather than three sections down inside the world
 * panel. The sky is the thing in this world most worth playing with, and it was the one
 * control you had to open a dialog to reach.
 */
export function TimeOfDayBar({
  hours,
  auto,
  onChange,
  onToggleAuto,
}: {
  hours: number;
  auto: boolean;
  onChange: (hours: number) => void;
  onToggleAuto: () => void;
}) {
  return (
    <div className="time-bar">
      <button
        type="button"
        className="time-bar-auto"
        role="switch"
        aria-checked={auto}
        aria-label="Cycle time of day"
        title="Cycle time of day"
        onClick={onToggleAuto}
      >
        {auto ? '⏸' : '▶'}
      </button>
      <input
        type="range"
        min={0}
        max={24}
        step={0.25}
        value={hours}
        aria-label="Time of day"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="time-bar-clock">{formatClock(hours)}</span>
    </div>
  );
}
