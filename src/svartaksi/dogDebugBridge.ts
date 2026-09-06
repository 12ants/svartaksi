/** Typed diagnostic access stays separate from the versioned performance capture schema. */
import { isDevModeRequested } from './devMode';
import type { DogBehaviorState } from './dogCompanion';

export interface SvartaksiDogSnapshot {
  x: number;
  z: number;
  behavior: DogBehaviorState;
  trust: number;
}

export interface SvartaksiDogBridge {
  readonly schemaVersion: 1;
  get(): SvartaksiDogSnapshot | null;
}

declare global {
  interface Window {
    __SVARTAKSI_DOG__?: SvartaksiDogBridge;
  }
}

export function isDogDebugRequested(search: string): boolean {
  return isDevModeRequested(search);
}

export interface InstallDogDebugBridgeOptions {
  target?: Window & { __SVARTAKSI_DOG__?: SvartaksiDogBridge };
  search?: string;
  /** Reads the current frame's dog state. Injected rather than imported so this module
   * has no dependency on the runtime's own refs. */
  read: () => SvartaksiDogSnapshot | null;
}

export function installDogDebugBridge({
  target = window,
  search = target.location.search,
  read,
}: InstallDogDebugBridgeOptions): (() => void) | null {
  if (!isDogDebugRequested(search)) return null;

  const bridge: SvartaksiDogBridge = {
    schemaVersion: 1,
    get: () => read(),
  };
  target.__SVARTAKSI_DOG__ = bridge;

  return () => {
    if (target.__SVARTAKSI_DOG__ === bridge) delete target.__SVARTAKSI_DOG__;
  };
}
