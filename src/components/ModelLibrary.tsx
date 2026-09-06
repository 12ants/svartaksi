/**
 * Browse the companion model repository (`12ants/models`) and spawn a GLB into the world.
 *
 * The catalogue is discovered at open time rather than declared here, so a model added to
 * that repository shows up without a change to this one — see `world/modelLibrary.ts` for
 * why, and for the fallback when discovery fails. This component only owns the picker's
 * own state: which entry is selected, whether a spawn is in flight, and what to say when
 * one fails.
 */
import { useEffect, useState } from 'react';
import { listRemoteModels, type RemoteModel } from '../world/modelLibrary';

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return '';
  return bytes >= 1024 * 1024
    ? ` · ${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : ` · ${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function ModelLibrary({
  onSpawn,
  onClear,
  onTipLast,
}: {
  onSpawn: (model: RemoteModel) => Promise<unknown>;
  onClear: () => number;
  onTipLast: () => RemoteModel | null;
}) {
  const [models, setModels] = useState<readonly RemoteModel[]>([]);
  const [discovered, setDiscovered] = useState<boolean | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listRemoteModels().then((result) => {
      // The panel can close while the listing is in flight; setting state then is a
      // React warning and a leak of this component's state into the next mount.
      if (!live) return;
      setModels(result.models);
      setDiscovered(result.discovered);
      setSelected((current) => current || result.models[0]?.fileName || '');
    });
    return () => { live = false; };
  }, []);

  const spawn = async () => {
    const model = models.find((entry) => entry.fileName === selected);
    if (!model || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await onSpawn(model);
      setMessage(`Spawned ${model.label}`);
    } catch (error) {
      // Shown, not swallowed: a stale fallback entry 404s here, and that is exactly the
      // case the person clicking needs to be told about.
      setMessage(`Could not spawn ${model.label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="render-section-title">Model library</h3>
      <p className="model-library-note">
        GLBs from <code>12ants/models</code>, spawned in front of you and scaled to fit.
        Decoration only — no collision, and they outlive a world rebuild. A model authored
        Z-up spawns on its end; <em>Tip last</em> turns it upright.
      </p>
      <div className="model-library">
        <select
          value={selected}
          aria-label="Model to spawn"
          disabled={!models.length}
          onChange={(event) => setSelected(event.target.value)}
        >
          {models.map((model) => (
            <option key={model.fileName} value={model.fileName}>
              {model.label}{sizeLabel(model.bytes)}
            </option>
          ))}
        </select>
        <div className="model-library-actions">
          <button type="button" onClick={spawn} disabled={busy || !selected}>
            {busy ? 'Spawning…' : 'Spawn'}
          </button>
          <button
            type="button"
            title="Tip the last spawned model a quarter turn — for GLBs authored Z-up"
            onClick={() => {
              const tipped = onTipLast();
              setMessage(tipped ? `Tipped ${tipped.label}` : 'Nothing spawned to tip');
            }}
          >
            Tip last
          </button>
          <button
            type="button"
            onClick={() => {
              const removed = onClear();
              setMessage(removed ? `Removed ${removed} model${removed === 1 ? '' : 's'}` : 'Nothing to remove');
            }}
          >
            Clear
          </button>
        </div>
        {discovered === false && (
          <p className="model-library-note" role="status">
            Could not read the repository listing — showing the models it held at build time.
          </p>
        )}
        {message && <p className="model-library-note" role="status">{message}</p>}
      </div>
    </>
  );
}
