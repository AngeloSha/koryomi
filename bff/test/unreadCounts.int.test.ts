// The number on every cover in the app.
//
// `seriesDto` (lib/ownedCatalog.ts) builds a Komga-shaped series DTO, and it has no idea who is asking -- it
// is a pure row-to-DTO mapping. So it shipped placeholders: booksReadCount 0, booksInProgressCount 0, and
// booksUnreadCount = the total chapter count. Every card in the web app reads booksUnreadCount, so every
// badge showed the CHAPTER COUNT and never moved, no matter how much of the series you had read. On a
// 200-chapter series that had read all year, the badge still said 200.
//
// The fix belongs on the server, not in the three components that render it: those three fields are published
// in openapi.yaml and served to OPDS and any third-party client, so a DTO that reports "all unread" is a false
// statement in the API rather than a rendering choice. lib/enrich.ts is the one place that knows the user.
//
// The same extraction closes a second hole. /api/favorites and /api/collections/:id returned raw DTOs with no
// enrichment at all -- no `yomi` block, no `color` -- so those two rails could not show a rating, a new-chapter
// count, or a cover tint, and nothing announced it.
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

const S1 = 's_uc_read';     // 5 chapters: 2 finished, 1 part-way
const S2 = 's_uc_untouched'; // 3 chapters, never opened
const ALL = [S1, S2];
const USER = 'uc-user';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  await migrate();
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM favorites WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});

  const counts: Record<string, number> = { [S1]: 5, [S2]: 3 };
  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!uc',$1,$2,$3)`,
      [id, `T!uc/${id}`, counts[id]]);
    for (let n = 1; n <= counts[id]; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
               VALUES ($1,$2,'T!uc',$3,$4,$5)`, [`b_${id}_${n}`, id, `T!uc/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
  }
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]);
  const uid = u[0].id;

  // Two finished, one part-way through. The third state matters: booksInProgressCount was hardcoded 0 too.
  for (const n of [1, 2]) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
             VALUES ($1,$2,$3,20,true)`, [uid, `b_${S1}_${n}`, S1]);
  }
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
           VALUES ($1,$2,$3,4,false)`, [uid, `b_${S1}_3`, S1]);
  await q('INSERT INTO favorites (user_id, series_id) VALUES ($1,$2)', [uid, S1]);

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(personalRoutes);
  await app.ready();
  return { app, q, uid, auth: { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` } };
}

test('the unread badge counts what is unread', { skip }, async (t) => {
  const { app, q, auth } = await setup();
  try {
    await t.test('THE BUG: a series you have read reports the chapters you have NOT read', async () => {
      // Reintroduce by dropping the three count overrides from enrichSeries in bff/src/lib/enrich.ts: this
      // reports 5 unread out of 5 chapters for a series with two finished, which is what every cover in the
      // app said before, for every series, forever.
      const r = await app.inject({ method: 'GET', url: `/api/series/${S1}`, headers: auth });
      assert.equal(r.statusCode, 200, r.payload);
      const s = r.json();
      assert.equal(s.booksCount, 5);
      assert.equal(s.booksReadCount, 2, 'two chapters were completed');
      assert.equal(s.booksUnreadCount, 3, 'so three are unread — not five');
      assert.equal(s.booksInProgressCount, 1, 'one chapter is part-way through');
      assert.equal(s.yomi.unread, s.booksUnreadCount, 'the two spellings of the same fact must agree');
    });

    await t.test('a series never opened still reports everything unread', async () => {
      // The fix must not invert the bug: untouched really is all-unread, and that badge should stay.
      const s = (await app.inject({ method: 'GET', url: `/api/series/${S2}`, headers: auth })).json();
      assert.equal(s.booksUnreadCount, 3);
      assert.equal(s.booksReadCount, 0);
      assert.equal(s.booksInProgressCount, 0);
    });

    await t.test('THE SECOND HOLE: favourites are enriched like every other listing', async () => {
      // Reintroduce by removing the enrichSeries call from /api/favorites: the rail returns raw DTOs, so the
      // badge is wrong again, the rating and new-chapter count vanish, and slice 6 has no colour to tint with.
      const rows = (await app.inject({ method: 'GET', url: '/api/favorites', headers: auth })).json().content;
      const s = rows.find((x: any) => x.id === S1);
      assert.ok(s, 'the favourited series should be listed');
      assert.equal(s.booksUnreadCount, 3, 'the favourites rail showed the total chapter count');
      assert.ok(s.yomi, 'no yomi block: no rating, no new-chapter badge');
      assert.equal(s.yomi.favorite, true);
      assert.ok('color' in s, 'no color: the card cannot be tinted by its own cover');
    });

    await t.test('and so are the contents of a collection', async () => {
      const col = (await app.inject({
        method: 'POST', url: '/api/collections', headers: auth, payload: { name: 'uc-collection' },
      })).json();
      await app.inject({
        method: 'POST', url: `/api/collections/${col.id}/items`, headers: auth, payload: { seriesId: S1 },
      });
      const items = (await app.inject({ method: 'GET', url: `/api/collections/${col.id}`, headers: auth })).json().items;
      assert.equal(items.length, 1);
      assert.equal(items[0].booksUnreadCount, 3);
      assert.ok(items[0].yomi, 'a collection returned raw DTOs too');
      await q('DELETE FROM collections WHERE id = $1', [col.id]).catch(() => {});
    });

    await t.test('the counts add up to the chapter count', async () => {
      // read + unread === total, always. A drift here means two different queries disagree about a series.
      for (const id of ALL) {
        const s = (await app.inject({ method: 'GET', url: `/api/series/${id}`, headers: auth })).json();
        assert.equal(s.booksReadCount + s.booksUnreadCount, s.booksCount, `${id} does not add up`);
      }
    });
  } finally {
    await app.close();
    await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM favorites WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});
