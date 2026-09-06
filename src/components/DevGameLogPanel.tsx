import { useSyncExternalStore } from 'react';
import { clearLog, getLog, subscribe, type LogEntry } from '../svartaksi/gameLogger';

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString('sv-SE', { hour12: false });
}

/** Newest first, no auto-scroll to manage — simpler than the "auto-scroll to
 * the newest, at the bottom" original sketch, and just as readable in a small
 * fixed panel. */
export function DevGameLogPanel({ onClose }: { onClose: () => void }) {
  const entries = useSyncExternalStore(subscribe, getLog);
  const newestFirst = [...entries].reverse();

  return (
    <div className="dev-overlay dev-telemetry dev-log-panel" role="region" aria-label="Game log">
      <div className="dev-overlay-titlebar">
        <span className="dev-overlay-title">LOG</span>
        <button type="button" className="dev-overlay-close" aria-label="Close game log" onClick={onClose}>×</button>
      </div>
      <div className="dev-section-header">
        <span>{entries.length} events</span>
        <button type="button" className="text-button" onClick={clearLog}>Clear</button>
      </div>
      <div className="dev-event-log">
        {newestFirst.length === 0 ? (
          <p className="dev-event-empty">No events yet.</p>
        ) : (
          newestFirst.map((entry: LogEntry) => (
            <div key={entry.id} className="dev-event" data-event-type={entry.level}>
              <div className="dev-event-line">
                <span className="dev-event-type">{entry.level.toUpperCase()}</span>
                <time>{formatTime(entry.timestampMs)}</time>
              </div>
              <span>[{entry.category}] {entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
