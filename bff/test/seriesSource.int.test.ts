// "How far behind is this series?", and the column list that has to stay in step with itself.
//
// The updater has stamped `source_missing`, `source_chapters` and `source_checked_at` on every series it
// visits for months. `seriesDto` dropped all three, so the one number that answers "is there more of this?"
// was computed on a schedule and shown to nobody.
//
// The trap in adding them: `SERIES_COLS` selects FROM a subquery whose inner SELECT enumerates ITS columns
// explicitly. A column added to one and not the other does not fail the file that changed -- it makes EVERY
// series read fail at runtime, the detail page and the library grid and search and OPDS together. Both paths
// are exercised below for exactly that reason.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const BEHIND = 's_src_behind';   // checked, and the source has three we do not
const CLEAN = 's_src_clean';     // checked, nothing new
const ERRORED = 's_src_errored'; // asked, but the source did not answer
const FRESH = 's_src_fresh';     // never asked
const ALL = [BEHIND, CLEAN, ERRORED, FRESH];

test('a series carries what its source last said', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { owned } = (await import('../src/lib/ownedCatalog')) as any;
  await migrate();

  const clean = async () => { for (const id of ALL) await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {}); };
  await clean();
  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!src',$1,$1,3)`, [id]);
  }
  await q(`UPDATE lib_series SET source_checked_at = now(), source_chapters = 12, source_missing = 3 WHERE id = $1`, [BEHIND]);
  await q(`UPDATE lib_series SET source_checked_at = now(), source_chapters = 3,  source_missing = 0 WHERE id = $1`, [CLEAN]);
  await q(`UPDATE lib_series SET source_checked_at = now(), source_chapters = NULL, source_missing = NULL WHERE id = $1`, [ERRORED]);

  try {
    await t.test('THE COLUMN-LIST TRAP: both read paths survive', async () => {
      // Reintroduce by deleting `s.source_chapters` from the inner SELECT of `seriesSrcWith` while leaving
      // it in SERIES_COLS: both of these throw `column "source_chapters" does not exist`, and in the running
      // app that is a 500 on the series page, the library grid, search, every home rail and every OPDS feed.
      const one = await owned.series(SYSTEM_CTX, BEHIND);
      assert.equal(one.id, BEHIND, 'reading one series by id must work');
      const listed = await owned.seriesNew(SYSTEM_CTX, 0, 100);
      assert.ok(listed.content.length > 0, 'listing series must work');
      assert.ok(listed.content.some((s: any) => s.id === BEHIND), 'the listing must include the seeded series');
    });

    await t.test('behind: the count and the time it was measured', async () => {
      const s = await owned.series(SYSTEM_CTX, BEHIND);
      assert.equal(s.source.missing, 3);
      assert.equal(s.source.chapters, 12);
      assert.ok(Date.parse(s.source.checkedAt) > 0, 'checkedAt must be an ISO instant the client can parse');
    });

    await t.test('checked and clean is zero, which is NOT the same as never checked', async () => {
      // The whole reason `source` is one nested object rather than a flat `sourceMissing`. Flattened, both
      // of these would be falsy and the UI could not tell "nothing new" from "we have never looked".
      const clean = await owned.series(SYSTEM_CTX, CLEAN);
      const fresh = await owned.series(SYSTEM_CTX, FRESH);
      assert.equal(clean.source.missing, 0);
      assert.equal(fresh.source, null);
    });

    await t.test('a check that errored reports null, not zero', async () => {
      // The updater stamps checked_at whenever it ASKED, answered or not. Reporting 0 here would render as
      // "up to date" for a series whose source is simply down.
      const s = await owned.series(SYSTEM_CTX, ERRORED);
      assert.notEqual(s.source, null, 'it was checked, so the check must be reported');
      assert.equal(s.source.missing, null, 'a failed check is not "0 behind"');
    });

    await t.test('every listing path returns the same shape as the by-id path', async () => {
      const listed = (await owned.seriesNew(SYSTEM_CTX, 0, 100)).content.find((s: any) => s.id === BEHIND);
      const one = await owned.series(SYSTEM_CTX, BEHIND);
      assert.deepEqual(listed.source, one.source, 'a rail and the detail page must agree about the source');
    });
  } finally {
    await clean();
  }
});
