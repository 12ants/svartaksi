import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rootMock = vi.hoisted(() => {
  const render = vi.fn();
  return { render, createRoot: vi.fn(() => ({ render, unmount: vi.fn() })) };
});

vi.mock('react-dom/client', () => ({ createRoot: rootMock.createRoot }));

import { createSvartaksiRuntime, resolveWorldData, worldCacheKey } from '../../src/svartaksi/svartaksiRuntime';
import { resetAreaManifestCache } from '../../src/world/providers/areaManifestCache';
import { START_LOCATION } from '../../src/svartaksi/config';

type SceneReady = (api: {
  applySource: ReturnType<typeof vi.fn>;
  applyRenderOptions: ReturnType<typeof vi.fn>;
  applyTimeOfDay: ReturnType<typeof vi.fn>;
  applyTeleport: ReturnType<typeof vi.fn>;
  applySpawnRandomPlace: ReturnType<typeof vi.fn>;
  applyStartBusRide: ReturnType<typeof vi.fn>;
  applyStopBusRide: ReturnType<typeof vi.fn>;
  applyToggleVehicle: ReturnType<typeof vi.fn>;
  retryWorldLoad: ReturnType<typeof vi.fn>;
  startPerformanceCapture: ReturnType<typeof vi.fn>;
  snapshotPerformanceCapture: ReturnType<typeof vi.fn>;
  stopPerformanceCapture: ReturnType<typeof vi.fn>;
  setPerfVisible: ReturnType<typeof vi.fn>;
}) => void;

function createSceneApi() {
  return {
    applySource: vi.fn(), applyRenderOptions: vi.fn(), applyTimeOfDay: vi.fn(),
    applyTeleport: vi.fn(), applySpawnRandomPlace: vi.fn(() => false),
    applyStartBusRide: vi.fn(), applyStopBusRide: vi.fn(), applyToggleVehicle: vi.fn(),
    retryWorldLoad: vi.fn(), startPerformanceCapture: vi.fn(), snapshotPerformanceCapture: vi.fn(),
    stopPerformanceCapture: vi.fn(), setPerfVisible: vi.fn(), startIntro: vi.fn(),
  };
}

function renderedSceneReady(): SceneReady {
  const element = rootMock.render.mock.calls.at(-1)?.[0] as { props: { onReady: SceneReady } } | undefined;
  if (!element) throw new Error('SvartaksiScene was not rendered');
  return element.props.onReady;
}

function createRuntime() {
  return createSvartaksiRuntime({
    host: document.createElement('div'),
    onStatus: vi.fn(), onSpeed: vi.fn(), onFps: vi.fn(), onArea: vi.fn(), onNearby: vi.fn(),
    onMode: vi.fn(), onCameraMode: vi.fn(), onHint: vi.fn(), onSpeech: vi.fn(), onInspection: vi.fn(),
  });
}

describe('loadWorld area manifest', () => {
  beforeEach(() => {
    resetAreaManifestCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips the tile provider on a manifest hit for the starting area', async () => {
    // roads + buildings must clear loadWorld's insufficient-data guard (> 8 combined).
    const areaData = {
      source: 'maplibre',
      roads: Array.from({ length: 9 }, () => ({})),
      buildings: [],
      water: [],
      parks: [],
      labels: [],
      objects: [],
    };
    const cacheKey = worldCacheKey('maplibre', START_LOCATION);
    const manifest = {
      generatedAt: '2026-08-05T00:00:00.000Z',
      entries: [{ key: cacheKey, origin: START_LOCATION, file: 'svartaksi.json' }],
    };
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/worldcache/areas/manifest.json') {
        return { ok: true, json: async () => manifest } as Response;
      }
      if (input === '/worldcache/areas/svartaksi.json') {
        return { ok: true, json: async () => areaData } as Response;
      }
      throw new Error(`Unexpected fetch during a manifest hit: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await resolveWorldData(cacheKey, START_LOCATION, new AbortController().signal, undefined);

    expect(data).toEqual(areaData);
    expect(fetchMock).toHaveBeenCalledWith('/worldcache/areas/manifest.json', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('tiles.openfreemap.org'), expect.anything());
  });
});

describe('runtime performance capture readiness', () => {
  beforeEach(() => {
    rootMock.render.mockClear();
    rootMock.createRoot.mockClear();
  });

  it('replays an immediate capture start through createSvartaksiRuntime once the scene API is ready', async () => {
    const runtime = createRuntime();
    runtime.startPerformanceCapture();

    await Promise.resolve();
    const api = createSceneApi();
    renderedSceneReady()(api);

    expect(api.startPerformanceCapture).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('opens the cinematic once the scene API is ready, and only after the clock is set', async () => {
    const runtime = createRuntime();

    await Promise.resolve();
    const api = createSceneApi();
    renderedSceneReady()(api);

    expect(api.startIntro).toHaveBeenCalledTimes(1);
    // The intro forces its own dusk; a replayed applyTimeOfDay landing after it would put
    // the session's clock back over the top of the scene's.
    expect(api.applyTimeOfDay.mock.invocationCallOrder[0])
      .toBeLessThan(api.startIntro.mock.invocationCallOrder[0]);
    runtime.dispose();
  });

  it('clears a pending capture start when stopped before the scene API is ready', async () => {
    const runtime = createRuntime();
    runtime.startPerformanceCapture();
    expect(runtime.stopPerformanceCapture()).toBeNull();

    await Promise.resolve();
    const api = createSceneApi();
    renderedSceneReady()(api);

    expect(api.startPerformanceCapture).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
