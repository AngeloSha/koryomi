// The page-hash job has to FINISH.
//
// It walks the library in batches, and the batch query is "chapters with no page_hashes row". That makes
// "wrote nothing" and "not looked at yet" the same state, which is fine until a chapter produces no pages
// at all — an unreadable archive, an empty one, a file that has since been moved. Good chapters get rows
// and drop out of the query; a chapter that writes nothing is picked again, and again. Once the broken ones
// are all that is left, the loop has no exit: `batch.length` is never 0, and there is no pause in it.
//
// One such chapter in a library is enough, which on a real library is a near certainty.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SERIES = 's_phj';
const BOOK = 'b_phj_missing';

let q: typeof import('../src/lib/db').q;

const clean = async () => {
  await q('DELETE FROM page_hashes WHERE book_id = $1', [BOOK]).catch(() => {});
  await q('DELETE FROM lib_books WHERE id = $1', [BOOK]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
};

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  await clean();
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'T!phj','PH Job','/phj')`, [SERIES]);
  // Points at a file that is not there: the chapter can never yield a page.
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, pages)
     VALUES ($1, $2, 'T!phj', '/phj/does-not-exist.cbz', 1, 3)`,
    [BOOK, SERIES],
  );
});

after(async () => { if (DSN) await clean(); });

test('a chapter that yields no pages is not asked again forever', { skip }, async () => {
  const job = await import('../src/lib/pageHashJob');
  // `max` bounds the run so a regression fails the assertion instead of hanging the suite.
  await job.runPageHashBackfill({ max: 5 });

  const rows = await q<{ page: number; hash: string | null }>(
    'SELECT page, hash FROM page_hashes WHERE book_id = $1', [BOOK],
  );
  assert.equal(rows.length, 1, 'an unreadable chapter must leave exactly one mark that it was looked at');
  assert.equal(rows[0].page, 0, 'the mark is page 0 — not a real page, so it cannot be mistaken for one');
  assert.equal(rows[0].hash, null, 'and it carries no hash, so it can never match another page');

  // The point of the mark: the job's own "what is left" query must stop counting it.
  const left = await q<{ n: string }>(
    `SELECT count(*)::text n FROM lib_books b
      WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM page_hashes p WHERE p.book_id = b.id)`,
    [BOOK],
  );
  assert.equal(Number(left[0].n), 0, 'the chapter is still queued — the next batch picks it up again');
});

test('the mark is never served as a junk page', { skip }, async () => {
  // Page 0 sits in the same table the reader consults. It must be inert there.
  const { junkPagesFor } = await import('../src/lib/junkPages');
  assert.deepEqual([...await junkPagesFor(BOOK)], [], 'the sentinel leaked into the reader as a page');
});
