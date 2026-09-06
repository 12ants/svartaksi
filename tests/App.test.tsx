import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

type PlayerMode = 'car' | 'bus' | 'foot';
type CameraMode = 'chase' | 'hood' | 'cockpit' | 'orbit' | 'top-down' | 'cinematic' | 'freecam';

// Captures what App passed to createSvartaksiRuntime, so a test can drive the callbacks
// the way the real runtime does — notably onMode, which the runtime fires on its own
// when a bus reaches the end of its path.
const captured: {
  onStatus?: (status: {
    source: 'maplibre';
    phase: 'loading' | 'ready' | 'error';
    mode: 'initial' | 'streaming';
    progress: number;
    message: string;
    retryable: boolean;
  }) => void;
  onMode?: (mode: PlayerMode) => void;
  onCameraMode?: (mode: CameraMode) => void;
  onHint?: (hint: string | null) => void;
  onSpeech?: (line: string | null) => void;
  onArea?: (area: string) => void;
  onFps?: (fps: number) => void;
  onSpeed?: (speed: number) => void;
  onNearby?: (items: Array<{
    name: string;
    category: string;
    detail?: string;
    distance: number;
    direction: string;
  }>) => void;
} = {};

const runtime = {
  setSource: vi.fn(),
  setRenderOptions: vi.fn(),
  setCameraMode: vi.fn(),
  setCameraSettings: vi.fn(),
  setTimeOfDay: vi.fn(),
  setBlobControlScheme: vi.fn(),
  startPerformanceCapture: vi.fn(),
  snapshotPerformanceCapture: vi.fn(() => null),
  stopPerformanceCapture: vi.fn(() => null),
  getSpeed: () => 0,
  getPlayerLngLat: vi.fn(() => ({ lng: 18.0985, lat: 59.3210 })),
  getDogSnapshot: vi.fn(() => null),
  teleportTo: vi.fn(),
  spawnRandomPlace: vi.fn(() => true),
  // The real runtime announces the mode and the seat camera itself rather than
  // returning them; App has no other way to learn either, so the mock must too.
  startBusRide: vi.fn(() => {
    captured.onCameraMode?.('cockpit');
    captured.onMode?.('bus');
  }),
  // A stop request brakes the bus and then sets the player down on foot, switching
  // the camera to chase on the way. Collapsed to one synchronous step here.
  stopBusRide: vi.fn(() => {
    captured.onCameraMode?.('chase');
    captured.onMode?.('foot');
  }),
  toggleVehicle: vi.fn(),
  spawnCar: vi.fn(() => true),
  toggleBlobForm: vi.fn(),
  setBlobPointer: vi.fn(),
  releaseBlobPointer: vi.fn(),
  setInspectorEnabled: vi.fn(),
  setInspectorPointer: vi.fn(),
  retryWorldLoad: vi.fn(),
  setInputSourceState: vi.fn(),
  releaseInputSource: vi.fn(),
  setInputPaused: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('../src/svartaksi/svartaksiRuntime', () => ({
  createSvartaksiRuntime: vi.fn((options: {
    onMode: (mode: PlayerMode) => void;
    onCameraMode: (mode: CameraMode) => void;
    onHint: (hint: string | null) => void;
    onSpeech: (line: string | null) => void;
    onStatus: NonNullable<typeof captured.onStatus>;
    onArea: NonNullable<typeof captured.onArea>;
    onFps: NonNullable<typeof captured.onFps>;
    onSpeed: NonNullable<typeof captured.onSpeed>;
    onNearby: NonNullable<typeof captured.onNearby>;
  }) => {
    captured.onStatus = options.onStatus;
    captured.onMode = options.onMode;
    captured.onCameraMode = options.onCameraMode;
    captured.onHint = options.onHint;
    captured.onSpeech = options.onSpeech;
    captured.onArea = options.onArea;
    captured.onFps = options.onFps;
    captured.onSpeed = options.onSpeed;
    captured.onNearby = options.onNearby;
    return runtime;
  }),
}));

// The route resolver hits the Overpass API over the network; the ride tests only
// care that a resolved route reaches App's onGo handler.
const ROUTE_PATH = [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 60 }];
vi.mock('../src/svartaksi/busCorridor', () => ({
  resolveBusRoute: vi.fn(async () => ({
    ok: true as const,
    path: ROUTE_PATH,
    lengthMeters: 100,
    etaSeconds: 30,
    signalStops: [],
  })),
}));

// jsdom has no WebGL context, so the real maplibre-gl Map constructor (used by
// the OverMap overlay this file exercises) would throw; stub it like OverMap.test.tsx does.
// Registered map event handlers, so a test can drive BusOverMap's start/destination
// picks without a real map to click on.
// Keyed by registration kind as well as event name, so a once('load') cannot
// silently replace an on('load') registered by the same component.
const mapHandlers: Record<string, (event: unknown) => void> = {};

vi.mock('maplibre-gl', () => {
  const marker = {
    setLngLat: vi.fn(function () { return marker; }),
    addTo: vi.fn(function () { return marker; }),
    remove: vi.fn(),
  };
  const map = {
    on: vi.fn((event: string, handler: (event: unknown) => void) => { mapHandlers[`on:${event}`] = handler; }),
    off: vi.fn((event: string) => { delete mapHandlers[`on:${event}`]; }),
    once: vi.fn((event: string, handler: (event: unknown) => void) => { mapHandlers[`once:${event}`] = handler; }),
    setLayoutProperty: vi.fn(),
    load: vi.fn(),
    resize: vi.fn(),
    remove: vi.fn(),
    isStyleLoaded: vi.fn(() => false),
    getLayer: vi.fn(() => undefined),
    getSource: vi.fn(() => undefined),
    addLayer: vi.fn(),
    addSource: vi.fn(),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
  };
  return {
    default: {
      Map: vi.fn(function () { return map; }),
      Marker: vi.fn(function () { return marker; }),
    },
  };
});

/** Opens the bus picker, picks a start and a destination, and confirms the resolved
 * route — the full player path into the riding state. */
async function startRide() {
  fireEvent.keyDown(window, { key: 'b' });
  expect(await screen.findByText('BUS LINE')).toBeInTheDocument();
  await act(async () => { mapHandlers['on:click']({ lngLat: { lng: 18.09, lat: 59.32 } }); });
  await act(async () => { mapHandlers['on:click']({ lngLat: { lng: 18.11, lat: 59.33 } }); });
  fireEvent.click(await screen.findByRole('button', { name: 'Go' }));
}

/** Opens the world settings panel and returns its camera-mode buttons. */
function cameraButtons(): HTMLButtonElement[] {
  const group = screen.getByRole('group', { name: 'Camera mode' });
  return within(group).getAllByRole('button') as HTMLButtonElement[];
}

/** The HUD now boots in zen mode; call this first in any test that needs an
 * action button or the World/Dev overlays. */
function revealHud() {
  fireEvent.keyDown(window, { key: 'z' });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The handler registry is module-level like the mocks, so it has to be reset too —
  // otherwise a test can drive a previous test's unmounted map instance.
  for (const key of Object.keys(mapHandlers)) delete mapHandlers[key];
});

describe('Svartaksi', () => {
  it('installs the capture bridge only for its opt-in query and removes it on unmount', () => {
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?perfCapture=1');
    try {
      const app = render(<App />);
      expect(window.__SVARTAKSI_PERFORMANCE__).toBeDefined();
      app.unmount();
      expect(window.__SVARTAKSI_PERFORMANCE__).toBeUndefined();
    } finally {
      window.history.replaceState({}, '', previousUrl);
      delete window.__SVARTAKSI_PERFORMANCE__;
    }
  });

  it('boots in zen mode, then Z reveals and re-hides optional HUD regions', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: 'World settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'HUD visibility' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'z' });
    expect(screen.getByRole('button', { name: 'World settings' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'z' });
    expect(screen.queryByRole('button', { name: 'World settings' })).not.toBeInTheDocument();
  });

  it('keeps one overlay open, pauses input, and restores focus on Escape', () => {
    render(<App />);
    revealHud();
    const mapButton = screen.getByRole('button', { name: 'Open map' });
    fireEvent.click(mapButton);
    fireEvent.keyDown(window, { key: 'o' });
    expect(runtime.setInspectorEnabled).toHaveBeenLastCalledWith(true);
    expect(runtime.setInputPaused).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Teleport within Stockholm' })).not.toBeInTheDocument();
    expect(runtime.setInspectorEnabled).toHaveBeenLastCalledWith(false);
    expect(mapButton).toHaveFocus();
    expect(runtime.setInputPaused).toHaveBeenLastCalledWith(false);
  });

  it('renders the Three.js stage and discoverable primary actions', () => {
    render(<App />);
    revealHud();
    expect(screen.getByTestId('three-world')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'World settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open map' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open bus picker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spawn at random open place' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spawn a car' })).toBeInTheDocument();
  });

  it('applies quality and surface choices from the world panel', () => {
    // Surface toggles are a developer control and only render behind ?dev=1.
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?dev=1');
    try {
      render(<App />);
      revealHud();
      fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close world settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Developer tools' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Render water' }));

      expect(runtime.setRenderOptions).toHaveBeenLastCalledWith(expect.objectContaining({
        quality: 'performance',
        water: false,
      }));
    } finally {
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('exposes and persists every effective rendering control', () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));

    for (const label of [
      'Cinematic materials',
      'High-quality shadows',
      'Street lights',
      'Facade details',
      'Dynamic resolution',
    ]) {
      fireEvent.click(screen.getByRole('switch', { name: label }));
    }

    expect(runtime.setRenderOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      cinematicMaterials: false,
      highQualityShadows: false,
      streetLights: false,
      facadeDetails: false,
      dynamicResolution: false,
    }));
  });

  it('keeps SMS toasts off by default and shows them once enabled', async () => {
    render(<App />);
    revealHud();
    act(() => { captured.onArea?.('Ryssbergen'); });

    // Simulate a message arrival the way the SMS ticker would: drive the phone
    // open/close path is out of scope here, so this test only proves the switch's
    // wiring — that App reads showSmsToast rather than always rendering the toast.
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    const toggle = screen.getByRole('switch', { name: 'Show SMS and message toasts' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('tunes the terrain relief from the world panel and keeps it', () => {
    // Terrain sliders are a developer control (see svartaksi/devMode.ts) and only render
    // behind the ?dev=1 gate.
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?dev=1');
    try {
      render(<App />);
      revealHud();
      fireEvent.click(screen.getByRole('button', { name: 'Developer tools' }));

      fireEvent.change(screen.getByRole('slider', { name: 'Terrain height' }), { target: { value: '3' } });
      expect(runtime.setRenderOptions).toHaveBeenLastCalledWith(expect.objectContaining({
        terrain: expect.objectContaining({ enabled: true, scale: 3 }),
      }));

      fireEvent.change(screen.getByRole('slider', { name: 'Terrain edge slope' }), { target: { value: '12' } });
      expect(runtime.setRenderOptions).toHaveBeenLastCalledWith(expect.objectContaining({
        terrain: expect.objectContaining({ scale: 3, slope: 12 }),
      }));

      // The toggle keeps the tuning rather than resetting it, so switching the relief back
      // on returns to the world the player had set up.
      fireEvent.click(screen.getByRole('switch', { name: 'Landuse elevation' }));
      expect(runtime.setRenderOptions).toHaveBeenLastCalledWith(expect.objectContaining({
        terrain: { enabled: false, scale: 3, slope: 12 },
      }));
      expect(JSON.parse(localStorage.getItem('svartaksi:render-options') ?? '{}').terrain)
        .toEqual({ enabled: false, scale: 3, slope: 12 });
    } finally {
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('offers developer tools and monitors on the standard URL', () => {
    render(<App />);
    revealHud();

    expect(screen.queryByRole('button', { name: 'Developer tools' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'p' });
    expect(screen.queryByRole('region', { name: 'Performance monitor' })).toBeInTheDocument();
  });

  it('shows the developer surface behind ?dev=1', () => {
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?dev=1');
    try {
      render(<App />);
      revealHud();
      fireEvent.click(screen.getByRole('button', { name: 'Developer tools' }));

      expect(screen.getByRole('switch', { name: 'Physics wireframe' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Performance monitor' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Game log' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Game state' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Render water' })).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'p' });
      expect(screen.getByRole('region', { name: 'Performance monitor' })).toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('logs runtime events to the dev game log when devMode is on', () => {
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?dev=1');
    try {
      render(<App />);
      revealHud();
      fireEvent.click(screen.getByRole('button', { name: 'Developer tools' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Game log' }));

      act(() => { captured.onMode?.('foot'); });

      expect(screen.getByText(/now foot/)).toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('shows dog and story state in the dev state panel', () => {
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?dev=1');
    runtime.getDogSnapshot.mockReturnValue({ x: 12.5, z: -3.25, behavior: 'wary', trust: 42 });
    try {
      render(<App />);
      revealHud();
      fireEvent.click(screen.getByRole('button', { name: 'Developer tools' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Game state' }));

      const panel = screen.getByRole('region', { name: 'Game state' });
      expect(within(panel).getByText('wary')).toBeInTheDocument();
      expect(within(panel).getByText('42')).toBeInTheDocument();
    } finally {
      runtime.getDogSnapshot.mockReturnValue(null);
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('renders blocking initial progress, compact streaming progress, and retryable errors', () => {
    render(<App />);

    act(() => captured.onStatus?.({
      source: 'maplibre',
      phase: 'loading',
      mode: 'initial',
      progress: 0.55,
      message: 'Provider data fetched',
      retryable: false,
    }));
    expect(screen.getByRole('status', { name: 'Loading world' })).toHaveAttribute('aria-valuenow', '55');

    act(() => captured.onStatus?.({
      source: 'maplibre',
      phase: 'loading',
      mode: 'streaming',
      progress: 0.7,
      message: 'Building streamed world',
      retryable: false,
    }));
    expect(screen.queryByRole('status', { name: 'Loading world' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Streaming world' })).toHaveAttribute('aria-valuenow', '70');

    act(() => captured.onStatus?.({
      source: 'maplibre',
      phase: 'error',
      mode: 'streaming',
      progress: 0.7,
      message: 'Tile source unavailable',
      retryable: true,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry world load' }));
    expect(runtime.retryWorldLoad).toHaveBeenCalledTimes(1);
  });

  it('opens and closes the overmap overlay', async () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'Open map' }));
    expect(await screen.findByText('📍 Teleport within Stockholm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close map' }));
    expect(screen.queryByText('📍 Teleport within Stockholm')).not.toBeInTheDocument();
  });

  it('teleports the car when a preset location is selected', async () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'Open map' }));
    fireEvent.click(await screen.findByText('Gamla Stan'));
    expect(runtime.teleportTo).toHaveBeenCalledWith(18.0717, 59.3257);
  });

  it('spawns a car from the HUD', () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'Spawn a car' }));
    expect(runtime.spawnCar).toHaveBeenCalledTimes(1);
  });

  it('spawns a car from the world panel', () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'World settings panel' })).getByRole('button', { name: 'Spawn a car' }));
    expect(runtime.spawnCar).toHaveBeenCalledTimes(1);
  });

  it('spawns at a random safe open place from the world panel', () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'World settings panel' })).getByRole('button', { name: 'Spawn at random open place' }));
    expect(runtime.spawnRandomPlace).toHaveBeenCalledTimes(1);
  });

  it('toggles the rendered-world inspector with O without opening the map', () => {
    render(<App />);
    revealHud();
    fireEvent.keyDown(window, { key: 'o' });
    expect(runtime.setInspectorEnabled).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('complementary', { name: 'Rendered world inspector' })).toBeInTheDocument();
    expect(screen.queryByText('📍 Teleport within Stockholm')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(runtime.setInspectorEnabled).toHaveBeenLastCalledWith(false);
  });

  it('toggles the performance monitor with P behind the developer gate', () => {
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', '?dev=1');
    try {
      render(<App />);
      fireEvent.keyDown(window, { key: 'p' });
      expect(screen.getByRole('region', { name: 'Performance monitor' })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'p' });
      expect(screen.queryByRole('region', { name: 'Performance monitor' })).not.toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('opens the bus picker on B and closes it again on B', async () => {
    render(<App />);

    fireEvent.keyDown(window, { key: 'b' });
    expect(await screen.findByText('BUS LINE')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.queryByText('BUS LINE')).not.toBeInTheDocument();
  });

  it('enters the riding state once a resolved route is confirmed', async () => {
    render(<App />);
    revealHud();
    await startRide();

    expect(runtime.startBusRide).toHaveBeenCalledWith(ROUTE_PATH, []);
    expect(screen.queryByText('BUS LINE')).not.toBeInTheDocument();
    expect(screen.getByText('GET OFF', { selector: '.control-hint span' })).toBeInTheDocument();
    expect(screen.queryByText('DRIVE')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    // The ride starts in the passenger seat, but the camera stays switchable.
    for (const button of cameraButtons()) expect(button).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cockpit' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sets the player down on foot instead of reopening the picker when B is pressed while riding', async () => {
    render(<App />);
    revealHud();
    await startRide();

    fireEvent.keyDown(window, { key: 'b' });

    expect(runtime.stopBusRide).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('BUS LINE')).not.toBeInTheDocument();
    // The stop must actually leave the riding state, not just call the runtime —
    // and it lands on foot, not back behind the wheel.
    expect(screen.getByText('WALK')).toBeInTheDocument();
    expect(screen.queryByText('GET OFF')).not.toBeInTheDocument();
    expect(screen.queryByText('DRIVE')).not.toBeInTheDocument();
  });

  it('stays in the driving state when the runtime rejects the ride start', async () => {
    // A rejected start announces neither a mode nor a camera, exactly as the real
    // runtime's early return does.
    runtime.startBusRide.mockImplementationOnce(() => {});
    render(<App />);
    revealHud();
    await startRide();

    expect(runtime.startBusRide).toHaveBeenCalledWith(ROUTE_PATH, []);
    expect(screen.getByText('DRIVE')).toBeInTheDocument();
    expect(screen.queryByText('GET OFF')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    for (const button of cameraButtons()) expect(button).toBeEnabled();
  });

  it('follows the runtime onto foot when it ends the ride by itself', async () => {
    render(<App />);
    revealHud();
    await startRide();

    // What arrival at the end of the path does from inside useFrame.
    act(() => { captured.onCameraMode?.('chase'); captured.onMode?.('foot'); });

    expect(screen.getByText('WALK')).toBeInTheDocument();
    expect(screen.queryByText('GET OFF')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    expect(screen.getByRole('button', { name: 'Chase' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows and clears the runtime\'s transient hint', async () => {
    render(<App />);

    act(() => { captured.onHint?.('E · ENTER CAR'); });
    expect(screen.getByText('E · ENTER CAR')).toBeInTheDocument();

    act(() => { captured.onHint?.(null); });
    expect(screen.queryByText('E · ENTER CAR')).not.toBeInTheDocument();
  });

  it('shows a line somebody said, and shows it again when they repeat themselves', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      revealHud();

      act(() => { captured.onSpeech?.('Do not show us the phone.'); });
      expect(screen.getByText('Do not show us the phone.')).toBeInTheDocument();

      // A speaker's lines wrap, so the same sentence twice running is two events. The
      // hold timer having expired on the first must not swallow the second.
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByText('Do not show us the phone.')).not.toBeInTheDocument();
      act(() => { captured.onSpeech?.('Do not show us the phone.'); });
      expect(screen.getByText('Do not show us the phone.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the runtime to get in or out of the car on E, but not in freecam', () => {
    render(<App />);

    fireEvent.keyDown(window, { key: 'e' });
    expect(runtime.toggleVehicle).toHaveBeenCalledTimes(1);

    // Getting into a car you have detached the camera from is meaningless, so E does
    // nothing in freecam. Six presses of C from chase is the whole cycle back round to it.
    for (let press = 0; press < 6; press += 1) fireEvent.keyDown(window, { key: 'c' });
    expect(runtime.setCameraMode).toHaveBeenLastCalledWith('freecam');
    fireEvent.keyDown(window, { key: 'e' });
    expect(runtime.toggleVehicle).toHaveBeenCalledTimes(1);
  });

  it('cycles every camera mode in order with C, wrapping back to the start', () => {
    render(<App />);
    // Starts in chase, so C should walk the rest of the list and come back to it.
    for (const expected of ['hood', 'cockpit', 'orbit', 'top-down', 'cinematic', 'freecam', 'chase']) {
      fireEvent.keyDown(window, { key: 'c' });
      expect(runtime.setCameraMode).toHaveBeenLastCalledWith(expected);
    }
  });

  it('keeps cycling from whichever mode the runtime put the camera in', async () => {
    render(<App />);
    revealHud();
    await startRide();

    // Boarding a bus seats you in cockpit, which is the runtime's own decision — C
    // continues from there rather than from whatever the HUD last asked for.
    fireEvent.keyDown(window, { key: 'c' });
    expect(runtime.setCameraMode).toHaveBeenLastCalledWith('orbit');
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));
    expect(screen.getByRole('button', { name: 'Orbit' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('announces the current area and only the two nearest places, with no panel around them', () => {
    render(<App />);
    revealHud();
    act(() => {
      captured.onArea?.('Österlånggatan');
      captured.onNearby?.([
        { name: 'Storkyrkan', category: 'POI', distance: 40, direction: 'ahead' },
        { name: 'Stortorget', category: 'POI', distance: 90, direction: 'left' },
        { name: 'Kungliga slottet', category: 'POI', distance: 210, direction: 'behind' },
      ]);
    });

    expect(screen.getByText('Österlånggatan')).toBeInTheDocument();
    expect(screen.getByText(/Storkyrkan/)).toBeInTheDocument();
    // Third and beyond are dropped: this is a glance, not a list.
    expect(screen.queryByText(/Kungliga slottet/)).not.toBeInTheDocument();
    // No heading, no close button, no distances — the old boxed panel had all three.
    expect(screen.queryByText('NEARBY')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide nearby information' })).not.toBeInTheDocument();
  });

  it('lets each announcement go rather than parking it over the world', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      revealHud();
      act(() => { captured.onArea?.('Skeppsbron'); });
      expect(screen.getByText('Skeppsbron')).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.queryByText('Skeppsbron')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows speed, frame rate and the load-state dot as one line of text', () => {
    render(<App />);
    revealHud();
    act(() => {
      captured.onSpeed?.(42.4);
      captured.onFps?.(58.6);
    });

    expect(screen.getByLabelText('42 kilometers per hour')).toBeInTheDocument();
    expect(screen.getByLabelText('59 frames per second')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /World (loading|ready|error)/ })).toBeInTheDocument();
    // The separate bottom-left status line that repeated the same state in words is gone.
    expect(screen.queryByText(/LIVE ·/)).not.toBeInTheDocument();
  });

  it('drives time of day from the main screen and can cycle it on its own', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      revealHud();
      const slider = screen.getByLabelText('Time of day');
      fireEvent.change(slider, { target: { value: '6' } });
      expect(runtime.setTimeOfDay).toHaveBeenLastCalledWith(6);

      fireEvent.click(screen.getByRole('switch', { name: 'Cycle time of day' }));
      act(() => { vi.advanceTimersByTime(1000); });
      const [advanced] = runtime.setTimeOfDay.mock.calls.at(-1) ?? [];
      expect(advanced).toBeGreaterThan(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the camera, clock and readout choices on the next session', () => {
    const first = render(<App />);
    revealHud();
    fireEvent.keyDown(window, { key: 'c' });
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '3.5' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Cycle time of day' }));
    first.unmount();

    runtime.setCameraMode.mockClear();
    runtime.setTimeOfDay.mockClear();
    render(<App />);
    revealHud();

    // Applied to the runtime on startup, not merely remembered in the HUD.
    expect(runtime.setCameraMode).toHaveBeenCalledWith('hood');
    expect(runtime.setTimeOfDay).toHaveBeenCalledWith(3.5);
    expect(screen.getByRole('switch', { name: 'Cycle time of day' }))
      .toHaveAttribute('aria-checked', 'true');
  });

  it('drives the camera dials into the runtime and remembers them across a session', () => {
    const first = render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));

    fireEvent.change(screen.getByLabelText('Camera distance'), { target: { value: '1.6' } });
    fireEvent.change(screen.getByLabelText('Camera field of view'), { target: { value: '70' } });
    expect(runtime.setCameraSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: 1.6, fov: 70 }),
    );
    first.unmount();

    runtime.setCameraSettings.mockClear();
    render(<App />);
    // Applied on startup rather than only remembered in the HUD, so the world opens on
    // the framing the player left it at.
    expect(runtime.setCameraSettings).toHaveBeenCalledWith(
      expect.objectContaining({ distance: 1.6, fov: 70 }),
    );
  });

  it('offers a reset that is disabled until a dial has actually been moved', () => {
    render(<App />);
    revealHud();
    fireEvent.click(screen.getByRole('button', { name: 'World settings' }));

    const reset = screen.getByRole('button', { name: 'Reset camera settings' });
    expect(reset).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Camera pitch'), { target: { value: '18' } });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(reset).toBeDisabled();
    expect(runtime.setCameraSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ pitch: 0 }),
    );
  });

  it('routes touch actions through the runtime input API', () => {
    render(<App />);
    revealHud();
    const boost = screen.getByRole('button', { name: 'Boost', hidden: true });
    fireEvent.pointerDown(boost, { pointerId: 7 });
    expect(runtime.setInputSourceState).toHaveBeenCalledWith('touch', { boost: true });
    fireEvent.pointerCancel(boost, { pointerId: 7 });
    expect(runtime.setInputSourceState).toHaveBeenLastCalledWith('touch', { boost: false });
    fireEvent(document, new Event('visibilitychange'));
    expect(runtime.releaseInputSource).toHaveBeenCalledWith('touch');
  });
});
