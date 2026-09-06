import type { RefObject } from 'react';
import { WINDOW_CONTROL_RANGES, type RenderOptions } from '../world/renderOptions';
import { TERRAIN_SCALE_RANGE, TERRAIN_SLOPE_RANGE } from '../world/terrain';
import type { UserSettings } from '../svartaksi/userSettings';
import { ModelLibrary } from './ModelLibrary';
import type { RemoteModel } from '../world/modelLibrary';

type SurfaceKey = keyof Pick<RenderOptions, 'ground' | 'parks' | 'water' | 'roads' | 'buildings' | 'facades' | 'streetFurniture'>;
const SURFACES: Array<{ key: SurfaceKey; label: string }> = [
  { key: 'ground', label: 'Ground' }, { key: 'parks', label: 'Parks & land use' },
  { key: 'water', label: 'Water' }, { key: 'roads', label: 'Roads' },
  { key: 'buildings', label: 'Buildings' }, { key: 'facades', label: 'Facades' },
  { key: 'streetFurniture', label: 'Benches, trees & lamps' },
];
const DEV_QUALITY_OPTIONS: Array<{ key: 'physicsWireframe'; label: string }> = [
  { key: 'physicsWireframe', label: 'Physics wireframe' },
];

export function DevToolsPanel({
  renderOptions,
  onUpdateRenderOptions,
  showDevPerf,
  showDevLog,
  showDevState,
  onUpdateSettings,
  onSpawnModel,
  onClearSpawnedModels,
  onTipLastSpawnedModel,
  onClose,
  panelRef,
}: {
  renderOptions: RenderOptions;
  onUpdateRenderOptions: (next: RenderOptions) => void;
  showDevPerf: boolean;
  showDevLog: boolean;
  showDevState: boolean;
  onUpdateSettings: (patch: Partial<UserSettings>) => void;
  onSpawnModel: (model: RemoteModel) => Promise<unknown>;
  onClearSpawnedModels: () => number;
  onTipLastSpawnedModel: () => RemoteModel | null;
  onClose: () => void;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const updateTerrain = (patch: Partial<RenderOptions['terrain']>) => {
    onUpdateRenderOptions({ ...renderOptions, terrain: { ...renderOptions.terrain, ...patch } });
  };

  return (
    <section ref={panelRef} className="world-panel" role="dialog" aria-modal="true" aria-label="Developer tools panel">
      <div className="panel-heading">
        <div><small>DEVELOPER</small><h2>Dev tools</h2></div>
        <button onClick={onClose} aria-label="Close developer tools">×</button>
      </div>
      <ModelLibrary
        onSpawn={onSpawnModel}
        onClear={onClearSpawnedModels}
        onTipLast={onTipLastSpawnedModel}
      />
      <h3 className="render-section-title">Monitors</h3>
      <div className="render-options">
        <div className="render-option">
          <span>Performance monitor</span>
          <button
            role="switch"
            aria-label="Performance monitor"
            aria-checked={showDevPerf}
            onClick={() => onUpdateSettings({ showDevPerf: !showDevPerf })}
          >
            {showDevPerf ? 'On' : 'Off'}
          </button>
        </div>
        <div className="render-option">
          <span>Game log</span>
          <button
            role="switch"
            aria-label="Game log"
            aria-checked={showDevLog}
            onClick={() => onUpdateSettings({ showDevLog: !showDevLog })}
          >
            {showDevLog ? 'On' : 'Off'}
          </button>
        </div>
        <div className="render-option">
          <span>Game state</span>
          <button
            role="switch"
            aria-label="Game state"
            aria-checked={showDevState}
            onClick={() => onUpdateSettings({ showDevState: !showDevState })}
          >
            {showDevState ? 'On' : 'Off'}
          </button>
        </div>
        {DEV_QUALITY_OPTIONS.map(({ key, label }) => (
          <div className="render-option" key={key}>
            <span>{label}</span>
            <button
              role="switch"
              aria-label={label}
              aria-checked={renderOptions[key]}
              onClick={() => onUpdateRenderOptions({ ...renderOptions, [key]: !renderOptions[key] })}
            >
              {renderOptions[key] ? 'On' : 'Off'}
            </button>
          </div>
        ))}
      </div>
      <h3 className="render-section-title">Facade windows</h3>
      <div className="render-options">
        {WINDOW_CONTROL_RANGES.map(([key, min, max]) => {
          const label = { windowBrightness: 'Window brightness', windowOccupancy: 'Lit window density', windowWarmth: 'Window warmth', windowFrameWidth: 'Window frame width' }[key];
          return <label className="render-slider" key={key}>
            <span>{label}</span>
            <input type="range" aria-label={label} min={min} max={max} step={0.05}
              value={renderOptions[key]}
              onChange={event => onUpdateRenderOptions({ ...renderOptions, [key]: Number(event.target.value) })} />
            <output>{renderOptions[key].toFixed(2)}</output>
          </label>;
        })}
        <div className="render-option">
          <span>Window light casting</span>
          <button role="switch" aria-label="Window light casting" aria-checked={renderOptions.windowCastLight}
            onClick={() => onUpdateRenderOptions({ ...renderOptions, windowCastLight: !renderOptions.windowCastLight })}>
            {renderOptions.windowCastLight ? 'On' : 'Off'}
          </button>
        </div>
        <p>Nearby windows illuminate surfaces at night. Casting uses at most four nearby lights. Light spill does not cast shadows.</p>
      </div>
      <h3 className="render-section-title">Terrain</h3>
      <div className="render-options">
        <div className="render-option">
          <span>Landuse elevation</span>
          <button
            role="switch"
            aria-label="Landuse elevation"
            aria-checked={renderOptions.terrain.enabled}
            onClick={() => updateTerrain({ enabled: !renderOptions.terrain.enabled })}
          >
            {renderOptions.terrain.enabled ? 'On' : 'Off'}
          </button>
        </div>
        <label className="render-slider">
          <span>Height</span>
          <input
            type="range"
            aria-label="Terrain height"
            disabled={!renderOptions.terrain.enabled}
            min={TERRAIN_SCALE_RANGE.min} max={TERRAIN_SCALE_RANGE.max} step={TERRAIN_SCALE_RANGE.step}
            value={renderOptions.terrain.scale}
            onChange={(event) => updateTerrain({ scale: Number(event.target.value) })}
          />
          <output>{renderOptions.terrain.scale.toFixed(1)}x</output>
        </label>
        <label className="render-slider">
          <span>Edge slope</span>
          <input
            type="range"
            aria-label="Terrain edge slope"
            disabled={!renderOptions.terrain.enabled}
            min={TERRAIN_SLOPE_RANGE.min} max={TERRAIN_SLOPE_RANGE.max} step={TERRAIN_SLOPE_RANGE.step}
            value={renderOptions.terrain.slope}
            onChange={(event) => updateTerrain({ slope: Number(event.target.value) })}
          />
          <output>{renderOptions.terrain.slope.toFixed(1)}m/m</output>
        </label>
      </div>
      <h3 className="render-section-title">Surfaces</h3>
      <div className="render-options">
        {SURFACES.map(({ key, label }) => (
          <div className="render-option" key={key}>
            <span>{label}</span>
            <button role="switch" aria-label={`Render ${label.toLowerCase()}`}
              aria-checked={renderOptions[key]}
              onClick={() => onUpdateRenderOptions({ ...renderOptions, [key]: !renderOptions[key] })}>
              {renderOptions[key] ? 'On' : 'Off'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
