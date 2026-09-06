import { describe, expect, it } from 'vitest';
import {
  captureRendererIdentity,
  createPerformanceCapture,
  type PerformanceCaptureContext,
  type RendererInfoSource,
} from '../../src/performance/performanceCapture';
import { createPerformanceSampler, type PerformanceEnvironment } from '../../src/performance/performanceMetrics';
import { DEFAULT_RENDER_OPTIONS } from '../../src/world/renderOptions';
import type { WorldBuildDiagnostics } from '../../src/world/threeWorld';

const environment: PerformanceEnvironment = {
  scenarioId: 'unit-test', qualityTier: 'balanced', viewport: { width: 1440, height: 900 },
  devicePixelRatio: 1, userAgent: 'vitest', renderer: null, vendor: null, webglVersion: null,
  rendererKind: 'unknown', warmupDurationMs: 0, sampleDurationMs: 30_000, buildRevision: 'test',
};

const context: PerformanceCaptureContext = {
  environment,
  renderOptions: { ...DEFAULT_RENDER_OPTIONS, terrain: { ...DEFAULT_RENDER_OPTIONS.terrain } },
};

const renderer: RendererInfoSource = {
  render: { calls: 12, triangles: 34, points: 0, lines: 2, frame: 8 },
  memory: { geometries: 4, textures: 5 },
  programs: { length: 6 },
};

const build: WorldBuildDiagnostics = {
  generationId: 3, estimatedSlices: 8, finishedSlices: 6, worstSliceMs: 2.5,
  elapsedMs: 15, complete: false, replacementCount: 1,
  input: { buildings: 20, roads: 10, water: 2, parks: 4, objects: 6 },
  built: { buildings: 12, roads: 8, water: 2, parks: 4, objects: 6 },
};

describe('performance capture', () => {
  it('does no sampling until explicitly started', () => {
    const capture = createPerformanceCapture({ capacity: 2 });

    capture.recordFrame(16, 1);
    capture.recordRenderedFrame(renderer, build);

    const before = capture.snapshot(context);
    expect(before.frame.samples).toEqual([]);
    expect(before.renderer).toBeNull();
    expect(before.build).toBeNull();
  });

  it('keeps bounded frame samples and stops accepting new ones', () => {
    let now = 0;
    const capture = createPerformanceCapture({
      capacity: 2,
      sampler: createPerformanceSampler({ capacity: 2, clock: { now: () => now += 1 } }),
    });
    capture.start();
    capture.recordFrame(10, 1);
    capture.recordFrame(20, 0.9);
    capture.recordFrame(30, 0.8);

    expect(capture.snapshot(context).frame.samples).toEqual([
      { timestampMs: 2, frameMs: 20, renderBudgetScale: 0.9 },
      { timestampMs: 3, frameMs: 30, renderBudgetScale: 0.8 },
    ]);
    capture.stop(context);
    capture.recordFrame(40, 0.7);
    expect(capture.snapshot(context).frame.samples).toHaveLength(2);
  });

  it('copies mutable renderer and world diagnostics into immutable snapshots', () => {
    const capture = createPerformanceCapture({ capacity: 2 });
    capture.start();
    capture.recordFrame(16, 1);
    capture.recordRenderedFrame(renderer, build);

    const first = capture.snapshot(context);
    renderer.render.calls = 99;
    build.input.buildings = 99;
    first.renderer!.render.calls = -1;
    first.build!.built.roads = -1;
    first.source.featureCounts!.buildings = -1;
    first.renderOptions.terrain.enabled = false;

    const second = capture.stop(context);
    expect(second.renderer).toMatchObject({ render: { calls: 12 }, programs: 6 });
    expect(second.build).toMatchObject({ input: { buildings: 20 }, built: { roads: 8 } });
    expect(second.source.featureCounts).toMatchObject({ buildings: 20, roads: 10 });
    expect(second.renderOptions).toEqual(context.renderOptions);

    capture.recordFrame(20, 0.5);
    expect(capture.snapshot(context).frame.samples).toHaveLength(1);
  });

  it('does not share mutable sample arrays between captures', () => {
    const first = createPerformanceCapture({ capacity: 2 });
    const second = createPerformanceCapture({ capacity: 2 });
    first.start();
    second.start();
    first.recordFrame(16, 1);
    second.recordFrame(24, 0.8);

    const firstSnapshot = first.snapshot(context);
    firstSnapshot.frame.samples[0].frameMs = -1;

    expect(second.snapshot(context).frame.samples).toEqual([
      expect.objectContaining({ frameMs: 24, renderBudgetScale: 0.8 }),
    ]);
  });

  it('records unavailable renderer identity without guessing the backend kind', () => {
    expect(captureRendererIdentity({
      getExtension: () => null,
      getParameter: () => 'masked renderer',
    })).toEqual({ renderer: 'unavailable', vendor: 'unavailable' });
  });

  it('records debug renderer strings only through the debug extension', () => {
    const debugInfo = { UNMASKED_RENDERER_WEBGL: 101, UNMASKED_VENDOR_WEBGL: 102 };
    expect(captureRendererIdentity({
      getExtension: () => debugInfo,
      getParameter: (parameter) => ({ 101: 'SwiftShader', 102: 'Google' })[parameter],
    })).toEqual({ renderer: 'SwiftShader', vendor: 'Google' });
  });
});
