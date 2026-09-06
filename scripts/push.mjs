#!/usr/bin/env node
/**
 * Stamp the moment of the push, then push.
 *
 * The intro screen shows `build-stamp.json`'s timestamp (see `build-meta.ts`), which is
 * how you tell at a glance whether what is deployed is what you last pushed. That only
 * works if something writes it, and writing it by hand is something nobody will do — so
 * the stamp and the push are one command.
 *
 *   pnpm push                 push the current branch
 *   pnpm push -- --dry-run    write nothing, show what would happen
 *
 * Deliberately does NOT commit your work. It stamps, commits *only the stamp*, and pushes
 * whatever is already committed. A script that swept up unrelated working-tree changes
 * into a commit nobody reviewed is a worse problem than a stale stamp, so an unclean tree
 * stops it instead.
 */
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { formatStamp } from '../build-meta.ts';

const STAMP_PATH = new URL('../build-stamp.json', import.meta.url);
const STAMP_REPO_PATH = 'build-stamp.json';
const dryRun = process.argv.includes('--dry-run');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`\x1b[31m✗\x1b[0m ${message}`);
  process.exit(1);
}

let branch;
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch {
  fail('not a git checkout');
}
if (branch === 'HEAD') fail('detached HEAD — check out a branch before pushing');

// Anything dirty other than the stamp this script is about to write. Left uncommitted it
// would silently not be part of the push the stamp claims to describe.
const dirty = git('status', '--porcelain')
  .split('\n')
  .filter(Boolean)
  .filter((line) => line.slice(3) !== STAMP_REPO_PATH);
if (dirty.length) {
  fail(`working tree has uncommitted changes — commit or stash them first:\n${dirty.map((l) => `    ${l}`).join('\n')}`);
}

const now = new Date();
const pushedAt = formatStamp(now);
const contents = `${JSON.stringify({ pushedAt, pushedAtIso: now.toISOString() }, null, 2)}\n`;

console.log(`  branch    ${branch}`);
console.log(`  stamped   ${pushedAt}`);

if (dryRun) {
  console.log('  dry run — nothing written, nothing pushed');
  process.exit(0);
}

writeFileSync(STAMP_PATH, contents);
git('add', STAMP_REPO_PATH);
// Nothing to commit when the stamp happens to be byte-identical, which only occurs inside
// the same second; `--allow-empty` would make a junk commit, so skip instead.
const staged = git('diff', '--cached', '--name-only');
if (staged) git('commit', '-m', `Stamp push at ${pushedAt}`);

try {
  execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });
} catch {
  // The common cause is a non-fast-forward — someone else pushed while you were working —
  // not an unreachable remote, and saying the wrong one sends you looking in the wrong
  // place. Both remedies are named because the script cannot tell which it hit from an
  // exit code alone.
  fail(
    `push of ${branch} was rejected.\n`
    + '    If the remote has moved on:   git pull --no-rebase && pnpm push\n'
    + '    If the remote was unreachable: re-run once it is back.\n'
    + '    Either way the stamp commit is already in your local history; re-running restamps.',
  );
}
console.log(`\x1b[32m✓\x1b[0m pushed ${branch} at ${pushedAt}`);
