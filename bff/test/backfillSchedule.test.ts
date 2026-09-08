// The background backfills have to run AGAIN, not only once at boot.
//
// Both were one-shot `setTimeout`s: a single pass minutes after the server started, and nothing afterwards.
// Nothing else calls them either — not persistScan, not the updater sweep, not adding a series from Discover
// — so every chapter downloaded after that pass went unprocessed until the container happened to restart.
//
// Measured on a real library the day it shipped: 22 chapters, all added after that morning's boot, still
// unfingerprinted hours later, with 50–80 more arriving daily. A server that simply stays up was the worst
// case, which is exactly backwards.
//
// ⚠️ These drive the REAL schedulers and count how many times the work was actually invoked — not whether a
// timer was registered. A job that reschedules itself and then throws before doing anything would satisfy
// "a timeout exists" while being just as broken.
import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

// These schedulers reach the db module on import, which refuses to load without a DSN. Nothing here touches
// the database — the work is injected — but the import has to succeed, so give it something to parse. Set
// before the imports below, which is why those are dynamic (and in a hook: no top-level await here).
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

let schedulePageHashBackfill: typeof import('../src/lib/pageHashJob').schedulePageHashBackfill;
let scheduleFingerprintBackfill: typeof import('../src/lib/fingerprintJob').scheduleFingerprintBackfill;
let RECHECK_MS: number;

before(async () => {
  ({ schedulePageHashBackfill, RECHECK_MS } = await import('../src/lib/pageHashJob'));
  ({ scheduleFingerprintBackfill } = await import('../src/lib/fingerprintJob'));
});

/** Let an async tick's body finish before the clock moves again. */
const settle = () => new Promise((r) => setImmediate(r));

test('the page-hash backfill runs again, and again, after the first pass', async () => {
  let runs = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    schedulePageHashBackfill(5 * 60_000, 60_000, async () => { runs++; return undefined as never; });

    assert.equal(runs, 0, 'nothing runs before the boot delay elapses');
    mock.timers.tick(5 * 60_000);
    await settle();
    assert.equal(runs, 1, 'the first pass runs after the boot delay');

    // Reintroduce by deleting the `setTimeout(tick, everyMs)` at the end of the tick: this stays at 1, and
    // every chapter added after boot is never fingerprinted.
    mock.timers.tick(60_000);
    await settle();
    assert.equal(runs, 2, 'and it runs AGAIN — the entire point of the change');

    mock.timers.tick(60_000);
    await settle();
    assert.equal(runs, 3, 'and keeps going indefinitely');
  } finally {
    mock.timers.reset();
  }
});

test('the fingerprint backfill re-arms too', async () => {
  // Same defect, same fix. This column feeds folder rematch, so a stale backlog there quietly degrades a
  // different feature.
  let runs = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    scheduleFingerprintBackfill(1000, 5000, async () => { runs++; return undefined as never; });
    mock.timers.tick(1000);
    await settle();
    mock.timers.tick(5000);
    await settle();
    assert.equal(runs, 2);
  } finally {
    mock.timers.reset();
  }
});

test('a pass that throws still schedules the next one', async (t) => {
  // ⚠️ A job that stops rescheduling because one batch failed is the same bug in a new place: one transient
  // database blip and the feature is off until somebody restarts the container.
  // Reintroduce by moving the re-arm inside the `try`: the first failure ends the schedule for good.
  t.mock.method(globalThis.console, 'warn', () => {});
  let runs = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    schedulePageHashBackfill(100, 1000, async () => { runs++; throw new Error('a batch failed'); });
    mock.timers.tick(100);
    await settle();
    assert.equal(runs, 1);
    mock.timers.tick(1000);
    await settle();
    assert.equal(runs, 2, 'a failed pass must not end the schedule');
  } finally {
    mock.timers.reset();
  }
});

test('the recheck interval is six hours', () => {
  assert.equal(RECHECK_MS, 6 * 60 * 60_000);
});
