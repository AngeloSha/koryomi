// Which pages the reader skips, resolved against the database.
//
// `pageHash.test.ts` covers the rule itself — how much evidence is enough, and whose evidence counts. This
// file covers the half that only exists once there are rows: that a person's decision about a page beats
// the count, in BOTH directions, and survives the hash job running again.
//
// That override is what makes an automatic skip safe to turn on by default. Without it, a wrong flag is
// permanent and there is nothing the reader can do about it.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const CREDIT = 'aaaaaaaaaaaaaaaa';
const SERIES = 's_junk_test';

let q: typeof import('../src/lib/db').q;
let junkPagesFor: typeof import('../src/lib/junkPages').junkPagesFor;
let setPageOverride: typeof import('../src/lib/junkPages').setPageOverride;

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
});

/** Three chapters, each with a credit page 1 and a unique story page 2 — the shape the feature is for. */
beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM page_hashes WHERE book_id LIKE $1', ['b_junk%']);
  await q('DELETE FROM lib_books WHERE id LIKE $1', ['b_junk%']);
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]);
  await q(
    `INSERT INTO lib_series (id, source, title, folder) VALUES ($1, 'owned', 'Junk Test', '/junk')
     ON CONFLICT (id) DO NOTHING`, [SERIES],
  );
  for (let c = 1; c <= 3; c++) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, pages)
       VALUES ($1, $2, 'owned', $3, $4, 2) ON CONFLICT (id) DO NOTHING`,
      [`b_junk${c}`, SERIES, `/junk/ch${c}.cbz`, c],
    );
    await q(
      `INSERT INTO page_hashes (book_id, page, hash) VALUES ($1, 1, $2), ($1, 2, $3)
       ON CONFLICT (book_id, page) DO UPDATE SET hash = EXCLUDED.hash, override = NULL`,
      [`b_junk${c}`, CREDIT, `story00000000${c}`],
    );
  }
  ({ junkPagesFor, setPageOverride } = await import('../src/lib/junkPages'));
});

test('the page that repeats in every chapter is the one skipped', { skip }, async () => {
  const junk = await junkPagesFor('b_junk1');
  assert.deepEqual([...junk], [1], 'page 1 is the credit page, page 2 is the story');
});

test('a page can be rescued by hand, permanently', { skip }, async () => {
  // The escape hatch for a false positive. Reintroduce by letting the heuristic run after the override
  // instead of before: a page you un-flagged comes back the next time the hash job runs.
  await setPageOverride('b_junk1', 1, false);
  assert.deepEqual([...await junkPagesFor('b_junk1')], [], 'a hand-rescued page must never be skipped again');
  // and only for the chapter it was set on
  assert.deepEqual([...await junkPagesFor('b_junk2')], [1], 'rescuing one chapter must not rescue the rest');
});

test('a page can be marked by hand that the count would never reach', { skip }, async () => {
  // A one-off advert appears once, so repetition can never find it. Without this direction of the override
  // the feature would have nothing to say about the single most annoying kind of page.
  await setPageOverride('b_junk1', 2, true);
  assert.deepEqual([...await junkPagesFor('b_junk1')].sort(), [1, 2]);
});

test('re-running the hash job does not undo a decision', { skip }, async () => {
  await setPageOverride('b_junk1', 1, false);
  // Exactly what pageHashJob does on a second pass: re-upsert the hashes, touching nothing else.
  await q(
    `INSERT INTO page_hashes (book_id, page, hash, checked_at) VALUES ($1, 1, $2, now())
     ON CONFLICT (book_id, page) DO UPDATE SET hash = EXCLUDED.hash, checked_at = now()`,
    ['b_junk1', CREDIT],
  );
  assert.deepEqual([...await junkPagesFor('b_junk1')], [],
    'the job overwrote an override — a person’s decision must outlive the heuristic');
});

test('a chapter nobody has hashed yet skips nothing', { skip }, async () => {
  await q('DELETE FROM page_hashes WHERE book_id LIKE $1', ['b_junk%']);
  assert.deepEqual([...await junkPagesFor('b_junk1')], [],
    'no evidence must mean no skipping, not an empty chapter');
});
