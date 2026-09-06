import { useEffect, useState, type RefObject } from 'react';
import type { SvartaksiRuntime } from '../svartaksi/svartaksiRuntime';
import type { SvartaksiDogSnapshot } from '../svartaksi/dogDebugBridge';
import type { QuestLogEntry } from '../story/storyEngine';

const POLL_MS = 500;

/**
 * Live game-state readout, next to the perf/log panels: dog companion behavior and the
 * story engine's progress, both otherwise only visible through window.__SVARTAKSI_DOG__ (a
 * Playwright-only bridge, see dogDebugBridge.ts) or by reading localStorage by hand.
 * Polls the dog like DevPerfPanel polls performance capture; quest log and flags are
 * passed straight from App's own React state, which already re-renders on every unlock.
 */
export function DevStatePanel({
  runtimeRef,
  questLog,
  storyFlags,
  onClose,
}: {
  runtimeRef: RefObject<SvartaksiRuntime | null>;
  questLog: QuestLogEntry[];
  storyFlags: readonly string[];
  onClose: () => void;
}) {
  const [dog, setDog] = useState<SvartaksiDogSnapshot | null>(null);

  useEffect(() => {
    const read = () => setDog(runtimeRef.current?.getDogSnapshot() ?? null);
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(timer);
  }, [runtimeRef]);

  const latestQuests = [...questLog].reverse().slice(0, 8);

  return (
    <div className="dev-overlay dev-state-panel" role="region" aria-label="Game state">
      <div className="dev-overlay-titlebar">
        <span className="dev-overlay-title">STATE</span>
        <button type="button" className="dev-overlay-close" aria-label="Close game state" onClick={onClose}>×</button>
      </div>
      <div className="dev-section-header">Dog companion</div>
      <div className="dev-section-body">
        <div className="dev-row"><span className="dev-row-label">Behavior</span><span className="dev-row-value">{dog?.behavior ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Trust</span><span className="dev-row-value">{dog ? Math.round(dog.trust) : '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Position</span><span className="dev-row-value">{dog ? `${dog.x.toFixed(1)}, ${dog.z.toFixed(1)}` : '—'}</span></div>
      </div>
      <div className="dev-section-header">Story flags ({storyFlags.length})</div>
      <div className="dev-section-body">
        {storyFlags.length === 0 ? (
          <p className="dev-event-empty">No flags set yet.</p>
        ) : (
          storyFlags.map((flag) => <div className="dev-row" key={flag}><span className="dev-row-label">{flag}</span></div>)
        )}
      </div>
      <div className="dev-section-header">Quest log ({questLog.length})</div>
      <div className="dev-event-log">
        {latestQuests.length === 0 ? (
          <p className="dev-event-empty">No beats unlocked yet.</p>
        ) : (
          latestQuests.map((entry) => (
            <div key={`${entry.projectId}:${entry.beatId}`} className="dev-event" data-event-type="info">
              <div className="dev-event-line">
                <span className="dev-event-type">{entry.projectId}</span>
              </div>
              <span>{entry.title}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
