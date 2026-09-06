import type { PerformanceCaptureSnapshot } from './performanceCapture';

/** Add `?perfCapture=1` to install the browser-only capture automation bridge. */
export const PERFORMANCE_CAPTURE_QUERY_PARAMETER = 'perfCapture';
export const PERFORMANCE_BRIDGE_SCHEMA_VERSION = 1;
export const PERFORMANCE_BRIDGE_NOT_READY = 'SVARTAKSI_PERFORMANCE_NOT_READY';

export interface PerformanceBridgeStartOptions {
  /** Reserved for capture controls added to the runtime API in a later schema version. */
  readonly reserved?: never;
}

export interface SvartaksiPerformanceBridge {
  readonly schemaVersion: typeof PERFORMANCE_BRIDGE_SCHEMA_VERSION;
  readonly ready: Promise<void>;
  start(options?: PerformanceBridgeStartOptions): Promise<void>;
  snapshot(): Promise<PerformanceCaptureSnapshot | null>;
  stop(): Promise<PerformanceCaptureSnapshot | null>;
}

export interface PerformanceBridgeRuntime {
  startPerformanceCapture(): void;
  snapshotPerformanceCapture(): PerformanceCaptureSnapshot | null;
  stopPerformanceCapture(): PerformanceCaptureSnapshot | null;
}

export interface PerformanceBridgeInstallation {
  setRuntime(runtime: PerformanceBridgeRuntime): void;
  dispose(): void;
}

export interface InstallPerformanceBridgeOptions {
  target?: Window;
  search?: string;
}

declare global {
  interface Window {
    __SVARTAKSI_PERFORMANCE__?: SvartaksiPerformanceBridge;
  }
}

function bridgeError(): Error & { code: typeof PERFORMANCE_BRIDGE_NOT_READY } {
  const error = new Error(PERFORMANCE_BRIDGE_NOT_READY) as Error & {
    code: typeof PERFORMANCE_BRIDGE_NOT_READY;
  };
  error.code = PERFORMANCE_BRIDGE_NOT_READY;
  return error;
}

export function isPerformanceCaptureRequested(search: string): boolean {
  return new URLSearchParams(search).get(PERFORMANCE_CAPTURE_QUERY_PARAMETER) === '1';
}

/**
 * Installs the deliberately small automation surface used by the performance harness.
 * It is opt-in at the URL boundary, so normal players never receive a global or start a
 * sampler. The App supplies the runtime after its mount effect has constructed it.
 */
export function installPerformanceBridge({
  target = window,
  search = target.location.search,
}: InstallPerformanceBridgeOptions = {}): PerformanceBridgeInstallation | null {
  if (!isPerformanceCaptureRequested(search)) return null;

  let runtime: PerformanceBridgeRuntime | null = null;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const requireRuntime = (): PerformanceBridgeRuntime => {
    if (!runtime) throw bridgeError();
    return runtime;
  };
  const bridge: SvartaksiPerformanceBridge = {
    schemaVersion: PERFORMANCE_BRIDGE_SCHEMA_VERSION,
    ready,
    // `options` is part of the published signature but carries nothing yet; a caller may
    // already pass one, so it is accepted and ignored rather than rejected.
    async start() {
      requireRuntime().startPerformanceCapture();
    },
    async snapshot() {
      return requireRuntime().snapshotPerformanceCapture();
    },
    async stop() {
      return requireRuntime().stopPerformanceCapture();
    },
  };

  target.__SVARTAKSI_PERFORMANCE__ = bridge;

  return {
    setRuntime(nextRuntime) {
      runtime = nextRuntime;
      resolveReady?.();
      resolveReady = null;
    },
    dispose() {
      runtime = null;
      if (target.__SVARTAKSI_PERFORMANCE__ === bridge) delete target.__SVARTAKSI_PERFORMANCE__;
    },
  };
}
