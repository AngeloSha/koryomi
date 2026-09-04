// The offline store's schema version is load-bearing, and the safe way to add a field is not to touch it.
//
// v0.11.1: bumping this from 1 to 2 hung every reader. An IndexedDB version change waits for every other open
// connection to close, the service worker held one it never closed, the upgrade fired `blocked` with no
// handler, and the promise never settled. `loadChapter` awaits the offline lookup before anything else, so the
// reader sat on "Loading chapter…" forever. There are now blocked/blocking/terminated handlers and a 4s
// timeout, but the cheapest defence is simply not to need an upgrade.
//
// IndexedDB records are schemaless: `lastPage`, `lastPageAt` and `lastCompleted` were added to existing
// records with no version change at all, and an older record just lacks them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'lib', 'downloads.ts'), 'utf8');

test('the offline store version is still 2', () => {
  // Reintroduce by bumping VERSION to add a field: the upgrade can be blocked by the service worker's
  // connection and every reader hangs on "Loading chapter…". Add fields to records instead — they need no
  // upgrade. If a version bump is ever genuinely required (a new object store or index), this test is the
  // place to record why, and the blocked/blocking handlers below must be verified first.
  assert.match(src, /const VERSION = 2;/, 'the offline store version changed — read the comment in this test');
});

test('the upgrade guards that make a bump survivable are still there', () => {
  for (const guard of ['blocked(', 'blocking(', 'terminated(', 'DB_OPEN_TIMEOUT']) {
    assert.ok(src.includes(guard), `downloads.ts lost its ${guard} guard`);
  }
});
