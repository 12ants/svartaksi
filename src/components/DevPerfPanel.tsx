import { useEffect, useState, type RefObject } from 'react';
import type { SvartaksiRuntime } from '../svartaksi/svartaksiRuntime';
import type { PerformanceCaptureSnapshot } from '../performance/performanceCapture';

const POLL_MS = 500;

function fpsClass(fps: number): string {
  if (fps >= 50) return 'good';
  if (fps >= 30) return 'warn';
  return 'bad';
}

/**
 * Replaces the old r3f-perf overlay. Rather than sample anything itself, it
 * drives the capture pipeline svartaksiRuntime.tsx already ships for ?perfCapture=1
 * automation (see performanceCapture.ts) — start on mount, poll a snapshot,
 * stop on unmount — so this is a pure reader of already-tested infrastructure.
 */
export function DevPerfPanel({
  runtimeRef,
  onClose,
}: {
  runtimeRef: RefObject<SvartaksiRuntime | null>;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<PerformanceCaptureSnapshot | null>(null);

  useEffect(() => {
    let captureRuntime: SvartaksiRuntime | null = null;
    const tryStart = () => {
      if (captureRuntime || !runtimeRef.current) return;
      captureRuntime = runtimeRef.current;
      captureRuntime.startPerformanceCapture();
    };
    tryStart();
    const timer = window.setInterval(() => {
      tryStart();
      setSnapshot(runtimeRef.current?.snapshotPerformanceCapture() ?? null);
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      captureRuntime?.stopPerformanceCapture();
    };
  }, [runtimeRef]);

  const frameMsValues = snapshot?.frame.samples.map((sample) => sample.frameMs) ?? [];
  const sortedFrameMs = frameMsValues.toSorted((a, b) => a - b);
  const percentile = (rank: number): number | null => sortedFrameMs.length === 0
    ? null
    : sortedFrameMs[Math.ceil((rank / 100) * sortedFrameMs.length) - 1];
  const p50 = percentile(50);
  const p95 = percentile(95);
  const p99 = percentile(99);
  const latestFrameMs = frameMsValues.length > 0 ? frameMsValues[frameMsValues.length - 1] : null;
  const currentFps = latestFrameMs && latestFrameMs > 0 ? 1000 / latestFrameMs : 0;
  const longOver25 = frameMsValues.filter((ms) => ms > 25).length;
  const longOver50 = frameMsValues.filter((ms) => ms > 50).length;
  const renderer = snapshot?.renderer ?? null;
  const build = snapshot?.build ?? null;
  const tileSource = snapshot?.source.tileSource ?? null;

  const fmt = (value: number | null, suffix = ''): string => (value === null ? '—' : `${value.toFixed(1)}${suffix}`);

  return (
    <div className="dev-overlay" role="region" aria-label="Performance monitor">
      <div className="dev-overlay-titlebar">
        <span className="dev-overlay-title">PERF</span>
        <span className={`dev-fps-badge ${fpsClass(currentFps)}`}>{Math.round(currentFps)} FPS</span>
        <button type="button" className="dev-overlay-close" aria-label="Close performance monitor" onClick={onClose}>×</button>
      </div>
      <div className="dev-section-header">Frame</div>
      <div className="dev-section-body">
        <div className="dev-row"><span className="dev-row-label">p50</span><span className="dev-row-value">{fmt(p50, 'ms')}</span></div>
        <div className="dev-row"><span className="dev-row-label">p95</span><span className="dev-row-value">{fmt(p95, 'ms')}</span></div>
        <div className="dev-row"><span className="dev-row-label">p99</span><span className="dev-row-value">{fmt(p99, 'ms')}</span></div>
        <div className="dev-row"><span className="dev-row-label">&gt;25ms</span><span className="dev-row-value">{longOver25}</span></div>
        <div className="dev-row"><span className="dev-row-label">&gt;50ms</span><span className="dev-row-value">{longOver50}</span></div>
      </div>
      <div className="dev-section-header">Renderer</div>
      <div className="dev-section-body">
        <div className="dev-row"><span className="dev-row-label">Draw calls</span><span className="dev-row-value">{renderer?.render.calls ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Triangles</span><span className="dev-row-value">{renderer?.render.triangles ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Geometries</span><span className="dev-row-value">{renderer?.memory.geometries ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Textures</span><span className="dev-row-value">{renderer?.memory.textures ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Programs</span><span className="dev-row-value">{renderer?.programs ?? '—'}</span></div>
      </div>
      <div className="dev-section-header">World build</div>
      <div className="dev-section-body">
        <div className="dev-row"><span className="dev-row-label">Buildings</span><span className="dev-row-value">{build ? `${build.built.buildings}/${build.input.buildings}` : '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Roads</span><span className="dev-row-value">{build ? `${build.built.roads}/${build.input.roads}` : '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Worst slice</span><span className="dev-row-value">{build ? `${build.worstSliceMs.toFixed(1)}ms` : '—'}</span></div>
      </div>
      <div className="dev-section-header">Tiles</div>
      <div className="dev-section-body">
        <div className="dev-row"><span className="dev-row-label">Cache hits</span><span className="dev-row-value">{tileSource?.cacheHits ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Network</span><span className="dev-row-value">{tileSource?.networkFetches ?? '—'}</span></div>
        <div className="dev-row"><span className="dev-row-label">Decode fail</span><span className="dev-row-value">{tileSource?.decodeFailures ?? '—'}</span></div>
      </div>
      <div className="dev-section-header">Quality</div>
      <div className="dev-section-body">
        <div className="dev-row"><span className="dev-row-label">Tier</span><span className="dev-row-value">{snapshot?.renderOptions.quality ?? '—'}</span></div>
      </div>
    </div>
  );
}
