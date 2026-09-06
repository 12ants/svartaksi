/**
 * Opt-in debug surface for the bus ride and the rider walking inside it, so a Playwright
 * spec can prove the pill actually moves under player input while the bus is in transit,
 * without pixel comparison. Mirrors dogDebugBridge.ts's shape (a typed, schema-versioned
 * window.__SVARTAKSI_*__ global installed only when a URL flag is present) and is a
 * deliberately separate global for the same reason dogDebugBridge is separate from the
 * performance bridge: this is bus/rider state, not a performance metric and not the dog.
 * Available on standard and legacy development URLs.
 */
import { isDevModeRequested } from './devMode';
import type { BusPhase } from './busLifecycle';
import type { PlayerMode } from './svartaksiRuntime';

export interface SvartaksiBusRiderSnapshot {
  phase: BusPhase;
  mode: PlayerMode;
  /** Bus body pose, world space. */
  bus: { x: number; z: number; rotationY: number };
  /** Pill pose, world space. */
  person: { x: number; z: number };
  /** Rider's position within the bus cabin, in bus-local coordinates — what
   * clampToBusFloor bounds. Only meaningful while aboard; mirrors riderLocalOffsetRef. */
  riderLocal: { x: number; z: number };
}

export interface SvartaksiBusRiderBridge {
  readonly schemaVersion: 1;
  get(): SvartaksiBusRiderSnapshot | null;
  /**
   * Test-only control: boards a bus ride along whatever road is already loaded in the
   * current world, bypassing the opening ride's own cross-town corridor fetch and
   * pathfinding (see svartaksiRuntime.tsx's debugBoardBusRef). Returns true if a ride was
   * actually started. A normal player has no way to reach this — it is only reachable
   * through this diagnostic bridge.
   */
  board(): boolean;
}

declare global {
  interface Window {
    __SVARTAKSI_BUS_RIDER__?: SvartaksiBusRiderBridge;
  }
}

export function isBusRiderDebugRequested(search: string): boolean {
  return isDevModeRequested(search);
}

export interface InstallBusRiderDebugBridgeOptions {
  target?: Window & { __SVARTAKSI_BUS_RIDER__?: SvartaksiBusRiderBridge };
  search?: string;
  /** Reads the current frame's bus/rider state. Injected rather than imported so this
   * module has no dependency on the runtime's own refs. */
  read: () => SvartaksiBusRiderSnapshot | null;
  /** Attempts to start a bus ride for testing. See SvartaksiBusRiderBridge.board. */
  board: () => boolean;
}

/**
 * Installs window.__SVARTAKSI_BUS_RIDER__ when developer tools are available, or does nothing and
 * returns null otherwise — a normal player never receives the global. Returns a dispose
 * function that removes it, or null when nothing was installed.
 */
export function installBusRiderDebugBridge({
  target = window,
  search = target.location.search,
  read,
  board,
}: InstallBusRiderDebugBridgeOptions): (() => void) | null {
  if (!isBusRiderDebugRequested(search)) return null;

  const bridge: SvartaksiBusRiderBridge = {
    schemaVersion: 1,
    get: () => read(),
    board: () => board(),
  };
  target.__SVARTAKSI_BUS_RIDER__ = bridge;

  return () => {
    if (target.__SVARTAKSI_BUS_RIDER__ === bridge) delete target.__SVARTAKSI_BUS_RIDER__;
  };
}
