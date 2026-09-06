import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPerformanceBridge,
  isPerformanceCaptureRequested,
  PERFORMANCE_BRIDGE_NOT_READY,
  PERFORMANCE_BRIDGE_SCHEMA_VERSION,
} from '../../src/performance/installPerformanceBridge';
import type { PerformanceBridgeRuntime } from '../../src/performance/installPerformanceBridge';
import type { PerformanceCaptureSnapshot } from '../../src/performance/performanceCapture';

const snapshot: PerformanceCaptureSnapshot = {
  frame: {
    environment: {
      scenarioId: 'test', qualityTier: 'balanced', viewport: { width: 1, height: 1 },
      devicePixelRatio: 1, userAgent: 'test', renderer: null, vendor: null, webglVersion: null,
      rendererKind: 'unknown', warmupDurationMs: 0, sampleDurationMs: 0, buildRevision: 'test',
    },
    startedAtMs: 1,
    endedAtMs: 2,
    samples: [],
  },
  renderer: null,
  build: null,
  source: {
    featureCounts: null,
    tileSource: {
      cacheHits: 0, networkFetches: 0, workerDecodes: 0, fallbackDecodes: 0, decodeFailures: 0,
    },
  },
  renderOptions: {
    quality: 'balanced', ground: true, parks: true, water: true, roads: true, buildings: true,
    facades: true, streetFurniture: true, cinematicMaterials: true, highQualityShadows: true,
    streetLights: true, facadeDetails: true, dynamicResolution: true, physicsWireframe: false,
    terrain: { enabled: true, scale: 1, slope: 1 },
  },
};

function createRuntime(): PerformanceBridgeRuntime {
  return {
    startPerformanceCapture: vi.fn(),
    snapshotPerformanceCapture: vi.fn(() => snapshot),
    stopPerformanceCapture: vi.fn(() => snapshot),
  };
}

afterEach(() => {
  delete window.__SVARTAKSI_PERFORMANCE__;
});

describe('installPerformanceBridge', () => {
  it('recognizes only the documented opt-in query value', () => {
    expect(isPerformanceCaptureRequested('?perfCapture=1')).toBe(true);
    expect(isPerformanceCaptureRequested('?perfCapture=0')).toBe(false);
    expect(isPerformanceCaptureRequested('')).toBe(false);
  });

  it('leaves normal page loads without a global or sampler', () => {
    expect(installPerformanceBridge({ target: window, search: '' })).toBeNull();
    expect(window.__SVARTAKSI_PERFORMANCE__).toBeUndefined();
  });

  it('rejects calls before runtime readiness with a stable code', async () => {
    const installation = installPerformanceBridge({ target: window, search: '?perfCapture=1' });
    const bridge = window.__SVARTAKSI_PERFORMANCE__;
    expect(installation).not.toBeNull();
    expect(bridge?.schemaVersion).toBe(PERFORMANCE_BRIDGE_SCHEMA_VERSION);

    await expect(bridge?.start()).rejects.toMatchObject({ code: PERFORMANCE_BRIDGE_NOT_READY });
    await expect(bridge?.snapshot()).rejects.toMatchObject({ code: PERFORMANCE_BRIDGE_NOT_READY });
    await expect(bridge?.stop()).rejects.toMatchObject({ code: PERFORMANCE_BRIDGE_NOT_READY });
  });

  it('wraps the runtime capture API after ready and removes its global on cleanup', async () => {
    const installation = installPerformanceBridge({ target: window, search: '?perfCapture=1' });
    const bridge = window.__SVARTAKSI_PERFORMANCE__;
    const runtime = createRuntime();
    if (!installation || !bridge) throw new Error('bridge should be installed');

    installation.setRuntime(runtime);
    await bridge.ready;
    await bridge.start({});
    await expect(bridge.snapshot()).resolves.toEqual(snapshot);
    await expect(bridge.stop()).resolves.toEqual(snapshot);
    expect(runtime.startPerformanceCapture).toHaveBeenCalledOnce();
    expect(runtime.snapshotPerformanceCapture).toHaveBeenCalledOnce();
    expect(runtime.stopPerformanceCapture).toHaveBeenCalledOnce();

    installation.dispose();
    expect(window.__SVARTAKSI_PERFORMANCE__).toBeUndefined();
  });
});
