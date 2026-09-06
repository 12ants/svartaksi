import {
  createPerformanceSampler,
  type PerformanceEnvironment,
  type PerformanceSampler,
  type PerformanceSnapshot,
} from './performanceMetrics';
import { getTileSourceDiagnostics, type TileSourceDiagnostics } from '../world/providers/vectorTileSource';
import type { RenderOptions } from '../world/renderOptions';
import type { WorldBuildCounts, WorldBuildDiagnostics } from '../world/threeWorld';

export interface RendererInfoSnapshot {
  render: { calls: number; triangles: number; points: number; lines: number; frame: number };
  memory: { geometries: number; textures: number };
  programs: number;
}

export interface RendererInfoSource {
  render: { calls: number; triangles: number; points: number; lines: number; frame: number };
  memory: { geometries: number; textures: number };
  programs?: { length: number } | null;
}

export interface WebGLDebugRendererInfoSource {
  getExtension(name: 'WEBGL_debug_renderer_info'): unknown;
  getParameter(parameter: number): unknown;
}

export interface RendererIdentity {
  renderer: string;
  vendor: string;
}

interface WebGLDebugRendererInfo {
  UNMASKED_RENDERER_WEBGL: number;
  UNMASKED_VENDOR_WEBGL: number;
}

export interface PerformanceCaptureContext {
  environment: PerformanceEnvironment;
  renderOptions: RenderOptions;
}

export interface PerformanceSourceSnapshot {
  featureCounts: WorldBuildCounts | null;
  tileSource: TileSourceDiagnostics;
}

export interface PerformanceCaptureSnapshot {
  frame: PerformanceSnapshot;
  renderer: RendererInfoSnapshot | null;
  build: WorldBuildDiagnostics | null;
  source: PerformanceSourceSnapshot;
  renderOptions: RenderOptions;
}

export interface PerformanceCapture {
  start(): void;
  isCapturing(): boolean;
  recordFrame(frameMs: number, renderBudgetScale: number): void;
  recordRenderedFrame(renderer: RendererInfoSource, build: WorldBuildDiagnostics): void;
  snapshot(context: PerformanceCaptureContext): PerformanceCaptureSnapshot;
  stop(context: PerformanceCaptureContext): PerformanceCaptureSnapshot;
}

export interface PerformanceCaptureOptions {
  capacity?: number;
  sampler?: PerformanceSampler;
}

const DEFAULT_CAPACITY = 1_800;

function copyRendererInfo(info: RendererInfoSource): RendererInfoSnapshot {
  return {
    render: {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      frame: info.render.frame,
    },
    memory: { geometries: info.memory.geometries, textures: info.memory.textures },
    programs: info.programs?.length ?? 0,
  };
}

function copyRendererSnapshot(info: RendererInfoSnapshot): RendererInfoSnapshot {
  return {
    render: { ...info.render },
    memory: { ...info.memory },
    programs: info.programs,
  };
}

function copyBuildDiagnostics(build: WorldBuildDiagnostics): WorldBuildDiagnostics {
  return { ...build, input: { ...build.input }, built: { ...build.built } };
}

function copyRenderOptions(options: RenderOptions): RenderOptions {
  return { ...options, terrain: { ...options.terrain } };
}

function isWebGLDebugRendererInfo(value: unknown): value is WebGLDebugRendererInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return Number.isFinite(info.UNMASKED_RENDERER_WEBGL) && Number.isFinite(info.UNMASKED_VENDOR_WEBGL);
}

/**
 * Reads unmasked renderer identity only when the privacy-gated debug extension is
 * available. The caller owns `rendererKind`: strings alone are not reliable enough to
 * classify a browser's WebGL backend as hardware or software.
 */
export function captureRendererIdentity(context: WebGLDebugRendererInfoSource): RendererIdentity {
  const info = context.getExtension('WEBGL_debug_renderer_info');
  if (!isWebGLDebugRendererInfo(info)) return { renderer: 'unavailable', vendor: 'unavailable' };
  const renderer = context.getParameter(info.UNMASKED_RENDERER_WEBGL);
  const vendor = context.getParameter(info.UNMASKED_VENDOR_WEBGL);
  return {
    renderer: typeof renderer === 'string' ? renderer : 'unavailable',
    vendor: typeof vendor === 'string' ? vendor : 'unavailable',
  };
}

/**
 * A deliberately inert capture seam. Its hot-path method returns before reading or
 * allocating anything until a caller explicitly starts a capture.
 */
export function createPerformanceCapture({
  capacity = DEFAULT_CAPACITY,
  sampler = createPerformanceSampler({ capacity }),
}: PerformanceCaptureOptions = {}): PerformanceCapture {
  let active = false;
  let latestRenderer: RendererInfoSnapshot | null = null;
  let latestBuild: WorldBuildDiagnostics | null = null;

  const snapshot = ({ environment, renderOptions }: PerformanceCaptureContext): PerformanceCaptureSnapshot => {
    const build = latestBuild && copyBuildDiagnostics(latestBuild);
    return {
      frame: sampler.snapshot(environment),
      renderer: latestRenderer && copyRendererSnapshot(latestRenderer),
      build,
      source: {
        featureCounts: build ? { ...build.input } : null,
        tileSource: getTileSourceDiagnostics(),
      },
      renderOptions: copyRenderOptions(renderOptions),
    };
  };

  return {
    start() {
      sampler.reset();
      latestRenderer = null;
      latestBuild = null;
      active = true;
    },
    isCapturing: () => active,
    recordFrame(frameMs, renderBudgetScale) {
      if (!active) return;
      sampler.recordFrame(frameMs, renderBudgetScale);
    },
    recordRenderedFrame(renderer, build) {
      if (!active) return;
      latestRenderer = copyRendererInfo(renderer);
      latestBuild = copyBuildDiagnostics(build);
    },
    snapshot,
    stop(environment) {
      const result = snapshot(environment);
      active = false;
      return result;
    },
  };
}
