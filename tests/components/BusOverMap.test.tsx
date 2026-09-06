import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusOverMap } from '../../src/components/BusOverMap';
import { localToLngLat } from '../../src/world/geo';
import { START_LOCATION } from '../../src/svartaksi/config';
import type { LocalPoint } from '../../src/world/types';

type MapPointerEvent = { lngLat: { lng: number; lat: number } };
const clickHandlers: Array<(event: MapPointerEvent) => void> = [];
const moveHandlers: Array<(event: MapPointerEvent) => void> = [];

interface StubMarker {
  remove: ReturnType<typeof vi.fn>;
  setLngLat: ReturnType<typeof vi.fn>;
  /** The `{ color }` the component constructed this marker with — how the tests
   * tell the start pin from the destination pin. */
  options: { color?: string; scale?: number };
}
const markers: StubMarker[] = [];
const START_COLOR = '#16a34a';
const DESTINATION_COLOR = '#f04f36';
const PREVIEW_SOURCE_ID = 'bus-route-preview';
const PREVIEW_LAYER_ID = 'bus-route-preview-line';

function markerByColor(color: string): StubMarker | undefined {
  return markers.find((marker) => marker.options.color === color);
}

// One stub map per Map() construction, with getSource/getLayer reflecting what
// was actually added or removed — teardown assertions are meaningless otherwise.
function createStubMap() {
  const sources = new Map<string, { spec: unknown; setData: ReturnType<typeof vi.fn> }>();
  const layers = new Set<string>();
  const idleHandlers: Array<() => void> = [];
  const styleLoaded = { value: true };
  const map = {
    styleLoaded,
    idleHandlers,
    center: [0, 0] as [number, number],
    on: vi.fn((event: string, handler: never) => {
      if (event === 'click') clickHandlers.push(handler as never);
      if (event === 'mousemove') moveHandlers.push(handler as never);
    }),
    off: vi.fn((event: string, handler: never) => {
      for (const [name, list] of [['click', clickHandlers], ['mousemove', moveHandlers]] as const) {
        if (name !== event) continue;
        const index = (list as unknown[]).indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      }
    }),
    setLayoutProperty: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'idle') idleHandlers.push(handler);
    }),
    resize: vi.fn(),
    remove: vi.fn(),
    isStyleLoaded: vi.fn(() => styleLoaded.value),
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string, spec: unknown) => { sources.set(id, { spec, setData: vi.fn() }); }),
    removeSource: vi.fn((id: string) => { sources.delete(id); }),
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    addLayer: vi.fn((layer: { id: string }) => { layers.add(layer.id); }),
    removeLayer: vi.fn((id: string) => { layers.delete(id); }),
  };
  return map;
}

type StubMap = ReturnType<typeof createStubMap>;
const maps: StubMap[] = [];

vi.mock('maplibre-gl', () => ({
  default: {
    Map: vi.fn(function (options: { center: [number, number] }) {
      const map = createStubMap();
      map.center = options.center;
      maps.push(map);
      return map;
    }),
    Marker: vi.fn(function (options: { color?: string } = {}) {
      const marker: StubMarker & { addTo: unknown } = {
        options,
        setLngLat: vi.fn(() => marker),
        addTo: vi.fn(() => marker),
        remove: vi.fn(),
      };
      markers.push(marker);
      return marker;
    }),
  },
}));

const resolveBusRoute = vi.fn();
vi.mock('../../src/svartaksi/busCorridor', () => ({
  resolveBusRoute: (...args: unknown[]) => resolveBusRoute(...args),
}));

const ROUTE_SOURCE_ID = 'bus-route';
const ROUTE_LAYER_ID = 'bus-route-line';

function currentMap(): StubMap {
  return maps[maps.length - 1];
}

function expectedCoordinates(path: LocalPoint[]) {
  return path.map((point) => {
    const lngLat = localToLngLat(START_LOCATION, point);
    return [lngLat.lng, lngLat.lat];
  });
}

function clickMap(lng: number, lat: number) {
  fireEvent.click(screen.getByTestId('bus-map'));
  // The map is a stub, so its click handlers are invoked by hand. act() gives
  // them the same state flush that a real React event would have had.
  act(() => {
    clickHandlers.forEach((handler) => handler({ lngLat: { lng, lat } }));
  });
}

/** Hovers the map and waits out the preview debounce. Real time rather than fake
 * timers: the debounce hands off to a promise chain, and the tests below assert on what
 * lands after it, which fake timers would need pumping through by hand at every await. */
async function hoverMap(lng: number, lat: number) {
  act(() => {
    moveHandlers.forEach((handler) => handler({ lngLat: { lng, lat } }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

function renderPicker(onGo = vi.fn()) {
  clickHandlers.length = 0;
  moveHandlers.length = 0;
  const view = render(<BusOverMap initialLng={18.1} initialLat={59.3} onGo={onGo} onClose={() => {}} />);
  return { onGo, view };
}

describe('BusOverMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clickHandlers.length = 0;
    moveHandlers.length = 0;
    markers.length = 0;
    maps.length = 0;
  });

  it('opens centered on the player with the start already pinned there', () => {
    renderPicker();

    expect(currentMap().center).toEqual([18.1, 59.3]);
    const startMarker = markerByColor(START_COLOR);
    expect(startMarker).toBeDefined();
    expect(startMarker!.setLngLat).toHaveBeenCalledWith([18.1, 59.3]);
    // Nothing to route to yet, so no destination pin exists.
    expect(markerByColor(DESTINATION_COLOR)).toBeUndefined();
    expect(screen.getByText(/pick a destination/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go' })).not.toBeInTheDocument();
  });

  it('routes from the player position on the very first click', async () => {
    resolveBusRoute.mockResolvedValueOnce({
      ok: true, path: [{ x: 0, z: 0 }, { x: 300, z: 0 }], lengthMeters: 300, etaSeconds: 30,
    });
    renderPicker();

    clickMap(18.11, 59.31);

    await waitFor(() => expect(resolveBusRoute).toHaveBeenCalled());
    // Start is the player position the planner opened at, not anything clicked.
    expect(resolveBusRoute.mock.calls[0][0]).toEqual({ lng: 18.1, lat: 59.3 });
    expect(resolveBusRoute.mock.calls[0][1]).toEqual({ lng: 18.11, lat: 59.31 });
  });

  it('moves the start and re-routes when Set start is used', async () => {
    const route = { ok: true, path: [{ x: 0, z: 0 }, { x: 300, z: 0 }], lengthMeters: 300, etaSeconds: 30 };
    resolveBusRoute.mockResolvedValueOnce(route).mockResolvedValueOnce(route);
    renderPicker();

    clickMap(18.11, 59.31);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Set start' }));
    expect(screen.getByText(/move the start/i)).toBeInTheDocument();

    clickMap(18.05, 59.28);

    // The green pin moved rather than a third marker appearing, and the same
    // destination is re-routed from the new start.
    expect(markers.filter((marker) => marker.options.color === START_COLOR)).toHaveLength(1);
    expect(markerByColor(START_COLOR)!.setLngLat).toHaveBeenCalledWith([18.05, 59.28]);
    await waitFor(() => expect(resolveBusRoute).toHaveBeenCalledTimes(2));
    expect(resolveBusRoute.mock.calls[1][0]).toEqual({ lng: 18.05, lat: 59.28 });
    expect(resolveBusRoute.mock.calls[1][1]).toEqual({ lng: 18.11, lat: 59.31 });
  });

  it('asks for a destination, not a route, if the start is moved before one is picked', () => {
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: 'Set start' }));
    clickMap(18.05, 59.28);

    expect(screen.getByText(/pick a destination/i)).toBeInTheDocument();
    expect(resolveBusRoute).not.toHaveBeenCalled();
  });

  it('resolves a route on the destination click and offers Go', async () => {
    resolveBusRoute.mockResolvedValueOnce({
      ok: true, path: [{ x: 0, z: 0 }, { x: 300, z: 0 }], lengthMeters: 300, etaSeconds: 30, signalStops: [],
    });
    const { onGo } = renderPicker();

    clickMap(18.11, 59.31);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument());
    expect(screen.getByText(/300 m/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onGo).toHaveBeenCalledWith([{ x: 0, z: 0 }, { x: 300, z: 0 }], []);
  });

  it('draws the resolved path as a line layer in lng/lat space', async () => {
    const path: LocalPoint[] = [{ x: 0, z: 0 }, { x: 300, z: -120 }];
    resolveBusRoute.mockResolvedValueOnce({ ok: true, path, lengthMeters: 300, etaSeconds: 30 });
    renderPicker();

    clickMap(18.11, 59.31);

    const map = currentMap();
    await waitFor(() => expect(map.addSource).toHaveBeenCalled());
    expect(map.addSource).toHaveBeenCalledWith(ROUTE_SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: expectedCoordinates(path) },
      },
    });
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: ROUTE_LAYER_ID, type: 'line', source: ROUTE_SOURCE_ID,
    }));
  });

  it('defers the draw until the style has loaded', async () => {
    const path: LocalPoint[] = [{ x: 0, z: 0 }, { x: 50, z: 0 }];
    resolveBusRoute.mockResolvedValueOnce({ ok: true, path, lengthMeters: 50, etaSeconds: 5 });
    renderPicker();
    currentMap().styleLoaded.value = false;

    clickMap(18.11, 59.31);

    const map = currentMap();
    await waitFor(() => expect(map.once).toHaveBeenCalledWith('idle', expect.any(Function)));
    // Would fail if the deferral were dropped: the draw must not have happened yet.
    expect(map.addSource).not.toHaveBeenCalled();

    act(() => { map.idleHandlers.forEach((handler) => handler()); });
    expect(map.addSource).toHaveBeenCalledTimes(1);
    expect(map.addLayer).toHaveBeenCalledTimes(1);
  });

  it('updates an existing source rather than re-adding it', async () => {
    const path: LocalPoint[] = [{ x: 0, z: 0 }, { x: 200, z: 0 }];
    resolveBusRoute.mockResolvedValueOnce({ ok: true, path, lengthMeters: 200, etaSeconds: 20 });
    renderPicker();

    // Stand in for a source that survived from an earlier draw on this map.
    const map = currentMap();
    map.addSource(ROUTE_SOURCE_ID, { type: 'geojson' });
    map.addSource.mockClear();
    const source = map.getSource(ROUTE_SOURCE_ID)!;

    clickMap(18.11, 59.31);

    await waitFor(() => expect(source.setData).toHaveBeenCalledTimes(1));
    expect(source.setData).toHaveBeenCalledWith({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: expectedCoordinates(path) },
    });
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  it('shows an inline error and no Go button when routing fails', async () => {
    resolveBusRoute.mockResolvedValueOnce({ ok: false, reason: 'no-route' });
    renderPicker();

    clickMap(18.11, 59.31);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no route/i));
    expect(screen.queryByRole('button', { name: 'Go' })).not.toBeInTheDocument();
  });

  it('shows a fetch error distinctly', async () => {
    resolveBusRoute.mockResolvedValueOnce({ ok: false, reason: 'fetch-failed' });
    renderPicker();

    clickMap(18.11, 59.31);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i));
  });

  it('returns to the seeded start rather than a blank map when Reset is pressed', async () => {
    resolveBusRoute.mockResolvedValueOnce({
      ok: true, path: [{ x: 0, z: 0 }], lengthMeters: 0, etaSeconds: 0,
    });
    renderPicker();

    clickMap(18.11, 59.31);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument());

    const map = currentMap();
    expect(markers).toHaveLength(2);
    const startMarker = markerByColor(START_COLOR)!;
    startMarker.setLngLat.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    // The destination pin goes; the start pin stays and snaps back to the player.
    expect(markerByColor(DESTINATION_COLOR)!.remove).toHaveBeenCalledTimes(1);
    expect(startMarker.remove).not.toHaveBeenCalled();
    expect(startMarker.setLngLat).toHaveBeenCalledWith([18.1, 59.3]);
    expect(map.removeLayer).toHaveBeenCalledWith(ROUTE_LAYER_ID);
    expect(map.removeSource).toHaveBeenCalledWith(ROUTE_SOURCE_ID);
    expect(map.getLayer(ROUTE_LAYER_ID)).toBeUndefined();
    expect(map.getSource(ROUTE_SOURCE_ID)).toBeUndefined();
    expect(screen.getByText(/pick a destination/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go' })).not.toBeInTheDocument();
  });

  describe('realtime preview', () => {
    const route = { ok: true, path: [{ x: 0, z: 0 }, { x: 300, z: 0 }], lengthMeters: 300, etaSeconds: 30 };

    it('routes to wherever the pointer settles, before anything is clicked', async () => {
      resolveBusRoute.mockResolvedValue(route);
      renderPicker();

      await hoverMap(18.11, 59.31);

      expect(resolveBusRoute).toHaveBeenCalledTimes(1);
      expect(resolveBusRoute.mock.calls[0][1]).toEqual({ lng: 18.11, lat: 59.31 });
      // Drawn as its own dashed layer, so the preview is visibly not the committed route.
      expect(currentMap().addLayer).toHaveBeenCalledWith(expect.objectContaining({
        id: PREVIEW_LAYER_ID,
        source: PREVIEW_SOURCE_ID,
      }));
      expect(screen.getByTestId('route-preview')).toHaveTextContent(/300 m/);
    });

    it('ignores pointer movement too small to change the route', async () => {
      resolveBusRoute.mockResolvedValue(route);
      renderPicker();

      await hoverMap(18.11, 59.31);
      // Roughly 11m away — well inside the distance the router would snap away anyway.
      await hoverMap(18.1101, 59.3101);

      expect(resolveBusRoute).toHaveBeenCalledTimes(1);
    });

    it('commits a previewed route without asking the network again', async () => {
      resolveBusRoute.mockResolvedValue(route);
      renderPicker();

      await hoverMap(18.11, 59.31);
      expect(resolveBusRoute).toHaveBeenCalledTimes(1);

      clickMap(18.11, 59.31);

      await waitFor(() => expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument());
      // The preview already answered this exact start/destination pair.
      expect(resolveBusRoute).toHaveBeenCalledTimes(1);
    });

    it('says nothing when the pointer is over ground with no route to it', async () => {
      resolveBusRoute.mockResolvedValue({ ok: false, reason: 'no-route' });
      renderPicker();

      await hoverMap(18.11, 59.31);

      // Hovering is not a request, so a failure to route is not an error to report.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByTestId('route-preview')).not.toBeInTheDocument();
    });

    it('drops cached previews when the start moves', async () => {
      resolveBusRoute.mockResolvedValue(route);
      renderPicker();

      await hoverMap(18.11, 59.31);
      fireEvent.click(screen.getByRole('button', { name: 'Set start' }));
      clickMap(18.05, 59.28);
      await hoverMap(18.11, 59.31);

      // Same destination, different origin — the cached path no longer describes it.
      expect(resolveBusRoute).toHaveBeenCalledTimes(2);
      expect(resolveBusRoute.mock.calls[1][0]).toEqual({ lng: 18.05, lat: 59.28 });
    });
  });

  it('removes markers and the map on unmount', async () => {
    resolveBusRoute.mockResolvedValueOnce({
      ok: true, path: [{ x: 0, z: 0 }], lengthMeters: 0, etaSeconds: 0,
    });
    const { view } = renderPicker();

    clickMap(18.11, 59.31);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument());

    const map = currentMap();
    view.unmount();

    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => marker.remove.mock.calls.length === 1)).toBe(true);
    expect(map.remove).toHaveBeenCalledTimes(1);
    // Unmount must not flash an error even though an aborted resolve looks like a fetch failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
