import type { RuntimeStatus } from '../svartaksi/svartaksiRuntime';

/**
 * The one permanently visible piece of HUD: speed, frame rate, and a single coloured dot
 * for the state of the world stream. It replaces a three-part header (a brand block, a
 * large odometer-style speed panel, and a separate bottom-left status line that repeated
 * the same load state in words) with one line of small text.
 */
export function HudReadout({
  speed,
  fps,
  status,
}: {
  speed: number;
  fps: number;
  status: RuntimeStatus;
}) {
  return (
    <div className="hud-readout" aria-label="Status">
      <span
        className={`hud-dot ${status.phase}`}
        // The dot is the whole status indicator now, so what it means has to reach a
        // screen reader some other way than by colour.
        role="img"
        aria-label={`World ${status.phase}`}
        title={status.message}
      />
      <span aria-label={`${Math.round(speed)} kilometers per hour`}>
        {Math.round(speed)}<small>km/h</small>
      </span>
      <span aria-label={`${Math.round(fps)} frames per second`}>
        {Math.round(fps)}<small>fps</small>
      </span>
    </div>
  );
}
