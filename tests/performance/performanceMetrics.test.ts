import { describe, expect, it } from 'vitest';
import { createPerformanceSampler, nearestRankPercentile, type PerformanceEnvironment } from '../../src/performance/performanceMetrics';

const environment: PerformanceEnvironment = {
  scenarioId: 'unit-test', qualityTier: 'balanced', viewport: { width: 1440, height: 900 },
  devicePixelRatio: 1, userAgent: 'vitest', renderer: null, vendor: null, webglVersion: null,
  rendererKind: 'unknown', warmupDurationMs: 0, sampleDurationMs: 30_000, buildRevision: 'test',
};

function sampler(capacity = 8) {
  let now = 0;
  return { sampler: createPerformanceSampler({ capacity, clock: { now: () => now += 10 } }) };
}

describe('performance metrics', () => {
  it('evicts the oldest samples when the fixed capacity is exceeded', () => {
    const { sampler: capture } = sampler(2);
    capture.recordFrame(10, 1); capture.recordFrame(20, 0.9); capture.recordFrame(30, 0.8);
    expect(capture.snapshot(environment).samples).toEqual([
      { timestampMs: 20, frameMs: 20, renderBudgetScale: 0.9 },
      { timestampMs: 30, frameMs: 30, renderBudgetScale: 0.8 },
    ]);
  });

  it('uses ascending nearest-rank frame percentiles and derives effective FPS', () => {
    const { sampler: capture } = sampler();
    [40, 10, 30, 20].forEach((frameMs) => capture.recordFrame(frameMs, 1));
    expect(nearestRankPercentile([40, 10, 30, 20], 50)).toBe(20);
    expect(capture.report(environment).frame).toMatchObject({ p50Ms: 20, p95Ms: 40, p99Ms: 40, effectiveFps: { p50: 50, p95: 25, p99: 25 } });
  });

  it('rejects non-finite frame, scale, and clock input', () => {
    const { sampler: capture } = sampler();
    expect(() => capture.recordFrame(Number.NaN, 1)).toThrow('frameMs must be finite');
    expect(() => capture.recordFrame(16, Number.POSITIVE_INFINITY)).toThrow('renderBudgetScale must be finite');
    const brokenClock = createPerformanceSampler({ capacity: 1, clock: { now: () => Number.NaN } });
    expect(() => brokenClock.recordFrame(16, 1)).toThrow('clock.now() must be finite');
  });

  it('reports empty captures with null metrics and no raw samples by default', () => {
    const { sampler: capture } = sampler();
    const report = capture.report(environment);
    expect(report.frame).toEqual({ sampleCount: 0, minMs: null, maxMs: null, p50Ms: null, p95Ms: null, p99Ms: null, effectiveFps: { p50: null, p95: null, p99: null }, longFramesOver25Ms: 0, longFramesOver50Ms: 0, renderBudgetScale: { min: null, max: null } });
    expect(report.debug).toBeUndefined();
  });

  it('counts long frames, records the scale range, and remains JSON serializable', () => {
    const { sampler: capture } = sampler();
    capture.recordFrame(20, 1); capture.recordFrame(26, 0.75); capture.recordFrame(51, 0.5);
    const report = capture.report(environment, { includeDebugSamples: true });
    expect(report.frame).toMatchObject({ longFramesOver25Ms: 2, longFramesOver50Ms: 1, renderBudgetScale: { min: 0.5, max: 1 } });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
