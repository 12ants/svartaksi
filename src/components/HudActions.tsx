interface HudActionsProps {
  inspectorEnabled: boolean;
  onWorld: (trigger: HTMLElement) => void;
  onMap: (trigger: HTMLElement) => void;
  onBus: (trigger: HTMLElement) => void;
  onInspector: () => void;
  onRandomPlace: () => void;
  onSpawnCar: () => void;
  phoneOpen: boolean;
  /** Unread count, shown on the button so a message that has already faded off screen is
   * still findable. */
  phoneUnread: number;
  onPhone: () => void;
  devMode: boolean;
  onDev: (trigger: HTMLElement) => void;
  fullscreenSupported: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

export function HudActions({
  inspectorEnabled,
  onWorld,
  onMap,
  onBus,
  onInspector,
  onRandomPlace,
  onSpawnCar,
  phoneOpen,
  phoneUnread,
  onPhone,
  devMode,
  onDev,
  fullscreenSupported,
  isFullscreen,
  onToggleFullscreen,
}: HudActionsProps) {
  return (
    <nav className="hud-actions" aria-label="Game actions">
      <button type="button" aria-label="World settings" title="World settings" onClick={(event) => onWorld(event.currentTarget)}>WORLD</button>
      {devMode ? (
        <button type="button" aria-label="Developer tools" title="Developer tools" onClick={(event) => onDev(event.currentTarget)}>DEV</button>
      ) : null}
      <button type="button" aria-label="Open map" title="Open map" onClick={(event) => onMap(event.currentTarget)}>MAP</button>
      <button type="button" aria-label="Open bus picker" title="Bus picker (B)" aria-keyshortcuts="B" onClick={(event) => onBus(event.currentTarget)}>BUS <kbd>B</kbd></button>
      <button
        type="button"
        title="World inspector (O)"
        aria-label="Toggle world inspector"
        aria-keyshortcuts="O"
        aria-pressed={inspectorEnabled}
        onClick={onInspector}
      >
        INSPECT <kbd>O</kbd>
      </button>
      <button
        type="button"
        title="Phone (T)"
        aria-label={phoneUnread ? `Phone, ${phoneUnread} unread` : 'Phone'}
        aria-keyshortcuts="T"
        aria-pressed={phoneOpen}
        onClick={onPhone}
      >
        PHONE <kbd>T</kbd>{phoneUnread ? <span className="hud-badge">{phoneUnread}</span> : null}
      </button>
      <button type="button" aria-label="Spawn at random open place" title="Random safe place" onClick={onRandomPlace}>RANDOM</button>
      <button type="button" aria-label="Spawn a car" title="Spawn a car within reach" onClick={onSpawnCar}>CAR</button>
      {fullscreenSupported ? (
        <button
          type="button"
          className="hud-fullscreen"
          title="Toggle fullscreen"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          aria-pressed={isFullscreen}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? 'EXIT FULLSCREEN' : 'FULLSCREEN'}
        </button>
      ) : null}
    </nav>
  );
}
