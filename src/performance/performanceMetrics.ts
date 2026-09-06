/** A clock seam keeps capture timing deterministic in tests and free of framework ties. */
export interface PerformanceClock {
  now(): number;
}

export interface PerformanceEnvironment {
  scenarioId: string;
  qualityTier: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  userAgent: string;
  renderer: string | null;
  vendor: string | null;
  webglVersion: string | null;
  rendererKind: 'hardware' | 'software' | 'unknown';
  warmupDurationMs: number;
  sampleDurationMs: number;
  buildRevision: string;
}

export interface PerformanceSample {
  timestampMs: number;
  frameMs: number;
  renderBudgetScale: number;
}

/** Raw bounded samples are retained only for an in-process capture or explicit debug report. */
export interface PerformanceSnapshot {
  environment: PerformanceEnvironment;
  startedAtMs: number;
  endedAtMs: number;
  samples: PerformanceSample[];
}

export interface PerformanceReport {
  schemaVersion: 1;
  environment: PerformanceEnvironment;
  capturedAtMs: number;
  frame: {
    sampleCount: number;
    minMs: number | null;
    maxMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    effectiveFps: { p50: number | null; p95: number | null; p99: number | null };
    longFramesOver25Ms: number;
    longFramesOver50Ms: number;
    renderBudgetScale: { min: number | null; max: number | null };
  };
  debug?: { samples: PerformanceSample[] };
}

export interface PerformanceSamplerOptions {
  capacity: number;
  clock?: PerformanceClock;
}

export interface PerformanceSampler {
  recordFrame(frameMs: number, renderBudgetScale: number): void;
  reset(): void;
  snapshot(environment: PerformanceEnvironment): PerformanceSnapshot;
  report(environment: PerformanceEnvironment, options?: { includeDebugSamples?: boolean }): PerformanceReport;
}

const defaultClock: PerformanceClock = { now: () => performance.now() };

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

function cloneSample(sample: PerformanceSample): PerformanceSample {
  return { ...sample };
}

/**
 * Returns the nearest-rank percentile: rank `ceil(percentile / 100 * count)` in an
 * ascending set. An empty set has no percentile (`null`); a single value is every
 * percentile. Percentiles must be in the inclusive 0..100 range.
 */
export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
    throw new RangeError('percentile must be between 0 and 100');
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = percentile === 0 ? 0 : Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index];
}

function toFps(frameMs: number | null): number | null {
  return frameMs === null || frameMs === 0 ? null : 1000 / frameMs;
}

export function createPerformanceSampler({ capacity, clock = defaultClock }: PerformanceSamplerOptions): PerformanceSampler {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('capacity must be a positive safe integer');
  }

  let samples: PerformanceSample[] = [];
  let startedAtMs: number | null = null;

  const copySamples = () => samples.map(cloneSample);
  const createSnapshot = (environment: PerformanceEnvironment): PerformanceSnapshot => {
    const endedAtMs = samples.at(-1)?.timestampMs ?? startedAtMs ?? clock.now();
    requireFinite(endedAtMs, 'clock.now()');
    return {
      environment: { ...environment, viewport: { ...environment.viewport } },
      startedAtMs: startedAtMs ?? endedAtMs,
      endedAtMs,
      samples: copySamples(),
    };
  };

  return {
    recordFrame(frameMs, renderBudgetScale) {
      requireFinite(frameMs, 'frameMs');
      requireFinite(renderBudgetScale, 'renderBudgetScale');
      if (frameMs < 0) throw new RangeError('frameMs must not be negative');
      if (renderBudgetScale < 0 || renderBudgetScale > 1) {
        throw new RangeError('renderBudgetScale must be between 0 and 1');
      }

      const timestampMs = clock.now();
      requireFinite(timestampMs, 'clock.now()');
      if (startedAtMs === null) startedAtMs = timestampMs;
      samples.push({ timestampMs, frameMs, renderBudgetScale });
      if (samples.length > capacity) samples.shift();
    },
    reset() {
      samples = [];
      startedAtMs = null;
    },
    snapshot(environment) {
      return createSnapshot(environment);
    },
    report(environment, options) {
      const snapshot = createSnapshot(environment);
      const frameTimes = snapshot.samples.map((sample) => sample.frameMs);
      const scales = snapshot.samples.map((sample) => sample.renderBudgetScale);
      const p50Ms = nearestRankPercentile(frameTimes, 50);
      const p95Ms = nearestRankPercentile(frameTimes, 95);
      const p99Ms = nearestRankPercentile(frameTimes, 99);
      const report: PerformanceReport = {
        schemaVersion: 1,
        environment: snapshot.environment,
        capturedAtMs: snapshot.endedAtMs,
        frame: {
          sampleCount: frameTimes.length,
          minMs: frameTimes.length === 0 ? null : Math.min(...frameTimes),
          maxMs: frameTimes.length === 0 ? null : Math.max(...frameTimes),
          p50Ms,
          p95Ms,
          p99Ms,
          effectiveFps: { p50: toFps(p50Ms), p95: toFps(p95Ms), p99: toFps(p99Ms) },
          longFramesOver25Ms: frameTimes.filter((frameMs) => frameMs > 25).length,
          longFramesOver50Ms: frameTimes.filter((frameMs) => frameMs > 50).length,
          renderBudgetScale: {
            min: scales.length === 0 ? null : Math.min(...scales),
            max: scales.length === 0 ? null : Math.max(...scales),
          },
        },
      };
      if (options?.includeDebugSamples) report.debug = { samples: snapshot.samples };
      return report;
    },
  };
}
