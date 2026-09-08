// Marking a page as junk by hand is a WRITE THAT CHANGES WHAT EVERYONE SEES.
//
// The flag is not personal — there is one `page_hashes` row per page, and the reader consults it whoever is
// reading. So the route that sets it has to be at least as careful as the route that reads the page list,
// which carries its own comment about not letting a book id enumerate a chapter of a hidden series.
//
// It was not, when first written: it took `:id` and `:n` straight off the params and wrote them. A member
// with no access to a library could hide pages inside it, in a chapter nobody with access had ever opened,
// and the flag would then apply to the admin as well.
//
// The two books here are IDENTICAL apart from visibility — same page dimensions, same shape — so a pass
// cannot come from one of them merely failing to resolve for some unrelated reason.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const OPEN = 's_jo_open';
const HIDDEN = 's_jo_hidden';     // soft-deleted: visible to nobody
const ALL = [OPEN, HIDDEN];
const BOOK = (s: string) => `b_${s}`;
const USER = 'jo-user';
const DIMS = JSON.stringify([
  { name: '001.png', width: 600, height: 900 },
  { name: '002.png', width: 600, height: 900 },
  { name: '003.png', width: 600, height: 900 },
]);

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;

  await migrate();
  await q('DELETE FROM page_hashes WHERE book_id = ANY($1)', [ALL.map(BOOK)]).catch(() => {});
  await q('DELETE FROM lib_books WHERE id = ANY($1)', [ALL.map(BOOK)]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});

  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!jo',$1,$2,1)`,
      [id, `T!jo/${id}`]);
    // `page_dims` present on purpose: bookPages returns it without touching the disk, so neither book
    // depends on a file existing and the ONLY difference between them is whether the series is visible.
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, page_dims)
             VALUES ($1,$2,'T!jo',$3,1,'Chapter 1',3,$4)`,
      [BOOK(id), id, `T!jo/${id}/ch1.cbz`, DIMS]);
  }
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [HIDDEN]);

  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]);
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.ready();
  return { app, q, auth: { authorization: `Bearer ${app.jwt.sign({ sub: u[0].id, role: 'user' })}` } };
}

// Cleaning up AFTER as well as before. Hygiene, not a fix: a user left behind by this file is what first
// exposed the ordering bug in rematch and softDelete, which attach a progress row to `users LIMIT 1` and
// used to leave it there for their own next wipe to trip over. Their wipes clear it now, and that is what
// actually holds -- measured by removing this hook and running all three files together, which still
// passes. This just keeps the file from leaving rows around for the next one to reason about.
after(async () => {
  if (!DSN) return;
  const { q } = await import('../src/lib/db');
  await q('DELETE FROM page_hashes WHERE book_id = ANY($1)', [ALL.map(BOOK)]).catch(() => {});
  await q('DELETE FROM lib_books WHERE id = ANY($1)', [ALL.map(BOOK)]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
});

const put = (app: any, book: string, page: number, junk: boolean | null, auth: any) =>
  app.inject({ method: 'PUT', url: `/api/books/${book}/pages/${page}/junk`, headers: auth, payload: { junk } });

test('a page in a series you can see can be marked by hand', { skip }, async () => {
  const { app, q, auth } = await setup();
  try {
    const r = await put(app, BOOK(OPEN), 2, true, auth);
    assert.equal(r.statusCode, 200, r.body);
    const rows = await q('SELECT override FROM page_hashes WHERE book_id = $1 AND page = 2', [BOOK(OPEN)]);
    assert.equal((rows[0] as any)?.override, true, 'the decision must actually be stored');
  } finally { await app.close(); }
});

test('a page in a series you cannot see cannot be touched', { skip }, async () => {
  // Reintroduce by writing setPageOverride straight from :id and :n, skipping the bookPages resolve: this
  // returns 200 and the row appears, so a member hides pages in a library they have no access to.
  const { app, q, auth } = await setup();
  try {
    const r = await put(app, BOOK(HIDDEN), 2, true, auth);
    assert.equal(r.statusCode, 404, `expected 404 for a hidden series, got ${r.statusCode}`);
    const rows = await q('SELECT 1 FROM page_hashes WHERE book_id = $1', [BOOK(HIDDEN)]);
    assert.equal(rows.length, 0, 'nothing may be written for a book the caller cannot see');
  } finally { await app.close(); }
});

test('a page number outside the chapter is refused', { skip }, async () => {
  // Falls out of resolving the book first: the page list bounds the number. Without it a chapter could
  // accumulate override rows for pages that do not exist.
  const { app, auth } = await setup();
  try {
    assert.equal((await put(app, BOOK(OPEN), 99, true, auth)).statusCode, 400);
    assert.equal((await put(app, BOOK(OPEN), 0, true, auth)).statusCode, 400);
  } finally { await app.close(); }
});
