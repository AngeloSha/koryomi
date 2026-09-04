// Notes, and the series-level rules they had never been subject to.
//
// The bookmark routes two lines above these carry a `browsable()` join and a comment explaining exactly why:
// a bookmark names a series id, so listing them without the predicate is a way to learn that a series you
// cannot see exists, and what you once read of it. The notes routes beside them had no check at all --
// `GET /api/notes/:seriesId` answered for any id, and `POST /api/notes` wrote against any id, including a
// soft-deleted series, one in a library the account has no grant for, and one above its age cap.
//
// Nobody had noticed because nothing in the web app had ever called them: four routes, a table, an index and
// a SET NULL foreign key, with zero frontend references. Giving them a UI is what made the gap matter.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const OPEN = 's_nt_open';
const HIDDEN = 's_nt_hidden';   // soft-deleted: visible to nobody
const ALL = [OPEN, HIDDEN];
const USER = 'nt-user';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  await migrate();
  await q('DELETE FROM notes WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});

  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!nt',$1,$2,1)`,
      [id, `T!nt/${id}`]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
             VALUES ($1,$2,'T!nt',$3,1,'Chapter 1')`, [`b_${id}`, id, `T!nt/${id}/ch1.cbz`]);
  }
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [HIDDEN]);

  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]);
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  return { app, q, uid: u[0].id, auth: { authorization: `Bearer ${app.jwt.sign({ sub: u[0].id, role: 'user' })}` } };
}

test('notes obey the same visibility rule as everything else', { skip }, async (t) => {
  const { app, q, uid, auth } = await setup();
  const post = (seriesId: string, body: string) =>
    app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { seriesId, body } });

  try {
    await t.test('a note on a series you can see round-trips', async () => {
      assert.equal((await post(OPEN, 'the good arc starts here')).statusCode, 200);
      const rows = (await app.inject({ method: 'GET', url: '/api/notes', headers: auth })).json().content;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].body, 'the good arc starts here');
      assert.equal(rows[0].series_id, OPEN);
      assert.ok(rows[0].series_title, 'the listing must carry the series title, or the UI has nothing to group by');
    });

    await t.test('THE WRITE HOLE: a note cannot be created against a series you cannot see', async () => {
      // Reintroduce by removing the komga.series resolve from POST /api/notes: this returns 200, and a write
      // that succeeds against a hidden id has just confirmed the id exists.
      assert.equal((await post(HIDDEN, 'should never be stored')).statusCode, 404);
      const stored = await q('SELECT 1 FROM notes WHERE user_id = $1 AND series_id = $2', [uid, HIDDEN]);
      assert.equal(stored.length, 0, 'a refused write still wrote a row');
    });

    await t.test('THE READ HOLE: a hidden series\' notes are not listed, by either route', async () => {
      // Plant one directly, so the read is tested even though the write is now refused. A note can also
      // become invisible after the fact -- an admin soft-deletes or age-rates a series someone already
      // annotated -- and that is the case this covers.
      await q('INSERT INTO notes (user_id, series_id, body) VALUES ($1,$2,$3)', [uid, HIDDEN, 'planted']);
      // Reintroduce by dropping the browsable() join from either notes read: 'planted' comes back, and the
      // existence of a series this account cannot open is disclosed.
      const all = (await app.inject({ method: 'GET', url: '/api/notes', headers: auth })).json().content;
      assert.ok(!all.some((n: any) => n.series_id === HIDDEN), 'the full listing leaked a hidden series');
      const byId = (await app.inject({ method: 'GET', url: `/api/notes/${HIDDEN}`, headers: auth })).json().content;
      assert.equal(byId.length, 0, 'the by-series route leaked a hidden series');
      // The row itself is untouched: hiding is not deleting, and it comes back if the series is restored.
      const still = await q('SELECT 1 FROM notes WHERE user_id = $1 AND series_id = $2', [uid, HIDDEN]);
      assert.equal(still.length, 1, 'a filtered read must not delete anything');
    });

    await t.test('?seriesId= narrows the listing', async () => {
      const only = (await app.inject({ method: 'GET', url: `/api/notes?seriesId=${OPEN}`, headers: auth })).json().content;
      assert.equal(only.length, 1);
      assert.equal(only[0].series_id, OPEN);
      const none = (await app.inject({ method: 'GET', url: `/api/notes?seriesId=${HIDDEN}`, headers: auth })).json().content;
      assert.equal(none.length, 0);
    });

    await t.test('a note body is capped on edit, not only on create', async () => {
      // Reintroduce by dropping `.max(4000)` from the PATCH schema: this returns 200, and the create-time
      // cap becomes decorative -- post a short note, then edit it to any size at all.
      const mine = (await app.inject({ method: 'GET', url: '/api/notes', headers: auth })).json().content[0];
      const huge = 'x'.repeat(4001);
      const r = await app.inject({ method: 'PATCH', url: `/api/notes/${mine.id}`, headers: auth, payload: { body: huge } });
      assert.notEqual(r.statusCode, 200, 'an over-long edit was accepted');
      const after = await q<{ body: string }>('SELECT body FROM notes WHERE id = $1', [mine.id]);
      assert.ok(after[0].body.length <= 4000, 'a refused edit still wrote');
    });

    await t.test('the two read routes agree with each other', async () => {
      const all = (await app.inject({ method: 'GET', url: `/api/notes?seriesId=${OPEN}`, headers: auth })).json().content;
      const byId = (await app.inject({ method: 'GET', url: `/api/notes/${OPEN}`, headers: auth })).json().content;
      assert.deepEqual(all.map((n: any) => n.id).sort(), byId.map((n: any) => n.id).sort());
    });
  } finally {
    await app.close();
    await q('DELETE FROM notes WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});
