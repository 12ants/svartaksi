import type { HudRegion, HudVisibility } from '../hooks/useHudVisibility';

const REGIONS: Array<{ key: HudRegion; label: string }> = [
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Actions' },
  { key: 'context', label: 'Context' },
  { key: 'controls', label: 'Controls' },
];

export function HudVisibilityMenu({
  visibility,
  onChange,
  onClose,
}: {
  visibility: HudVisibility;
  onChange: (region: HudRegion, visible: boolean) => void;
  onClose: () => void;
}) {
  return (
    <section className="hud-visibility-menu" role="dialog" aria-modal="false" aria-label="HUD visibility">
      <div>
        <strong>HUD VISIBILITY</strong>
        <button type="button" aria-label="Close HUD visibility" onClick={onClose}>×</button>
      </div>
      {REGIONS.map(({ key, label }) => (
        <label key={key}>
          <span>{label}</span>
          <input
            type="checkbox"
            role="switch"
            checked={visibility[key]}
            onChange={(event) => onChange(key, event.target.checked)}
          />
        </label>
      ))}
    </section>
  );
}
