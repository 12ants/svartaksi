import type { InspectionHit } from '../svartaksi/svartaksiRuntime';

export function WorldInspectorPanel({
  hit,
  touchMode,
  onInspectHere,
}: {
  hit: InspectionHit | null;
  touchMode: boolean;
  onInspectHere: () => void;
}) {
  return (
    <aside className="world-inspector" aria-label="Rendered world inspector" aria-live="polite">
      <div className="world-inspector-crosshair" aria-hidden="true">+</div>
      <strong>WORLD INSPECTOR</strong>
      {!hit ? <p>Nothing under pointer.</p> : (
        <>
          <h2>{hit.title}</h2>
          <dl>
            <div><dt>Category</dt><dd>{hit.category}</dd></div>
            <div><dt>Source</dt><dd>{hit.source}</dd></div>
            <div><dt>ID</dt><dd>{hit.id}</dd></div>
            <div><dt>Distance</dt><dd>{hit.distanceMeters} m</dd></div>
            {Object.entries(hit.properties).map(([key, value]) => (
              <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{String(value)}</dd></div>
            ))}
          </dl>
        </>
      )}
      {touchMode && <button type="button" onClick={onInspectHere}>Inspect here</button>}
    </aside>
  );
}
