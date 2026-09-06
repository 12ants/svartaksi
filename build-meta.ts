import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

/** Where `scripts/push.mjs` records the moment of a push. Committed, so the timestamp the
 * intro screen shows is the one that shipped with this revision rather than whenever the
 * bundle happened to be compiled. */
export const BUILD_STAMP_FILE = new URL('./build-stamp.json', import.meta.url);

/**
 * The exact date and time this revision was pushed, formatted for the intro screen.
 *
 * Reads the committed stamp first, so a deployed bundle names the push it came from — the
 * whole point of showing it, which is being able to glance at the loading screen and know
 * whether what is live is what you last pushed. Falls back to the build's own clock where
 * there is no stamp (a plain `pnpm build`, a source tarball, a test run), which is still a
 * truthful answer to "when was this made", just a less useful one.
 *
 * Local time with the offset spelled out, not UTC: the person reading it is comparing
 * against the clock on their own wall.
 */
function buildTime(): string {
  try {
    if (existsSync(BUILD_STAMP_FILE)) {
      const stamp = JSON.parse(readFileSync(BUILD_STAMP_FILE, 'utf8')) as { pushedAt?: unknown };
      if (typeof stamp.pushedAt === 'string' && stamp.pushedAt) return stamp.pushedAt;
    }
  } catch {
    // A corrupt or unreadable stamp is not worth failing a build over; the clock below is
    // a perfectly good answer.
  }
  return formatStamp(new Date());
}

/** `2026-09-04 18:32:07 +02:00` — sortable, unambiguous, and readable at a glance. */
export function formatStamp(date: Date): string {
  const pad = (value: number, width = 2) => String(Math.floor(Math.abs(value))).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + ` ${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
}

/**
 * Shared `define` block for the app's build identity, injected as the global
 * `__BUILD_TIME__` constant the loading screen reads. Used by both vite.config.ts (the real
 * app build) and vitest.config.ts (component tests reference the same global), so both
 * resolve identically rather than duplicating the work.
 *
 * The commit hash used to be injected alongside it and shown on the intro screen. It is
 * gone: a short hash tells you nothing at a glance, and the timestamp answers the question
 * it was there for.
 */
export function buildDefine(): Record<string, string> {
  return {
    __BUILD_TIME__: JSON.stringify(buildTime()),
  };
}

/** Kept only so a caller that wants the revision can still ask for it; nothing in the UI
 * shows it any more. */
export function commitId(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}
