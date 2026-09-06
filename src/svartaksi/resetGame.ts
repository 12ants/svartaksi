/**
 * The reset/restart command: one place that knows every Svartaksi-owned localStorage key,
 * so a "reset all settings" action never has to guess and never reaches for
 * `localStorage.clear()`, which would also take out whatever the browser or another
 * origin's tooling keeps alongside it.
 *
 * A key belongs here the moment something starts persisting it, not when the reset
 * command happens to get written — an unlisted key is a bug, not an intentional
 * survivor.
 */
import { RENDER_OPTIONS_STORAGE_KEY } from '../world/renderOptions';
import { USER_SETTINGS_STORAGE_KEY } from './userSettings';
import { STORY_ENGINE_STORAGE_KEY } from '../story/storyEngine';
import { DOG_TRUST_STORAGE_KEY } from './dogTrust';

export const SVARTAKSI_STORAGE_KEYS: readonly string[] = [
  RENDER_OPTIONS_STORAGE_KEY,
  USER_SETTINGS_STORAGE_KEY,
  STORY_ENGINE_STORAGE_KEY,
  DOG_TRUST_STORAGE_KEY,
];

/** Keys this app used to persist under but no longer does — kept here only so "reset
 * all settings" can still clean them off a returning player's storage. Not part of
 * SVARTAKSI_STORAGE_KEYS because nothing reads these back; add a key here when you retire
 * one from that list, never when you add a new one. */
export const SVARTAKSI_LEGACY_STORAGE_KEYS: readonly string[] = [
  'svartaksi:hud-visibility',
];

/**
 * Removes every Svartaksi-owned key and nothing else. Errors from an individual removal
 * (a full or disabled storage) are collected rather than thrown on the first one, so a
 * failing key does not stop the rest from going.
 */
export function resetSvartaksiStorage(storage: Pick<Storage, 'removeItem'>): { failed: string[] } {
  const failed: string[] = [];
  for (const key of [...SVARTAKSI_STORAGE_KEYS, ...SVARTAKSI_LEGACY_STORAGE_KEYS]) {
    try {
      storage.removeItem(key);
    } catch {
      failed.push(key);
    }
  }
  return { failed };
}
