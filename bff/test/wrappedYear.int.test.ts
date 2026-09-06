// Wrapped, and the year it put your reading in.
//
// `/api/wrapped` selected `extract(year from created_at) = $2`. `created_at` is a timestamptz, so `extract`
// evaluates it in the DATABASE SESSION's timezone -- and the endpoint then bucketed months and weekdays with
// `new Date(...).getMonth()` / `.getDay()`, which use the SERVER PROCESS's timezone. `/api/stats`, twenty
// lines above, buckets in UTC. So the two endpoints disagreed with each other, and a chapter finished just
// either side of midnight on New Year's Eve was counted in the wrong year -- for every reader west of UTC,
// every year, silently.
//
// The first test below sets the session timezone itself, so it fails on the old predicate no matter what TZ
// the suite runs under. It has its own connection and never touches the shared pool, so it cannot leak that
// timezone into any other test file.
//
// The second bug the fix carries: `extract(year from col)` is a function on the column, so the index on
// (user_id, created_at) could not be used and every wrapped request scanned every event the account had
// ever recorded. A half-open range is sargable.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

// THIS FILE RUNS IN A WESTERN TIMEZONE, ON BOTH SIDES, ON PURPOSE.
//
// Under TZ=UTC -- which is what CI and the container use -- the old code and the new code agree exactly, so
// a test written the ordinary way would pass against the bug and prove nothing. Both halves of the defect
// only appear away from UTC, so both are moved there:
//
//   * `process.env.TZ` before the first Date, which V8 re-reads, so `getMonth()`/`getDay()` would bucket in
//     New York time. `node --test` gives every test FILE its own process, so this leaks into nothing else.
//   * `PGOPTIONS`, which node-postgres passes to the server as session options, so `extract(year from ...)`
//     would evaluate the timestamptz in New York time too.
//
// With both set, the assertions below fail if either half of the fix is reverted.
process.env.TZ = 'America/New_York';
process.env.PGOPTIONS = '-c timezone=America/New_York';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'wrapped-year';
const SERIES = 's_wy_a';

// 23:30 UTC on 31 December is 18:30 the same day in New York -- still 2025 either way. 00:30 UTC on 1
// January is 19:30 on 31 DECEMBER in New York, and that is the instant the two readings disagree about.
const NYE = '2025-12-31T23:30:00Z';
const NYD = '2026-01-01T00:30:00Z';

test('THE YEAR BUG: a UTC year boundary, read from a session that is not in UTC', { skip }, async () => {
  const c = new Client({ connectionString: DSN });
  await c.connect();
  try {
    const { rows: [r] } = await c.query(
      `SELECT extract(year from ts)::int                                     AS by_extract,
              (ts >= make_timestamptz(2026,1,1,0,0,0,'UTC'))                 AS in_2026_utc
         FROM (SELECT $1::timestamptz AS ts) t`, [NYD]);
    // This is the defect itself, stated as an assertion: the same instant is 2025 to `extract` and 2026 in
    // UTC. Reintroduce the old predicate and every reader in a western timezone gets this year's New Year's
    // Eve reading filed under last year.
    assert.equal(r.by_extract, 2025, 'the old predicate reads this instant as 2025');
    assert.equal(r.in_2026_utc, true, 'the new predicate reads the same instant as 2026');
  } finally {
    await c.end();
  }
});

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!wy',$1,$1,1)`, [SERIES]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
           VALUES ($1,$2,'T!wy',$3,1,'Chapter 1') ON CONFLICT DO NOTHING`, [`b_${SERIES}`, SERIES, 'wy/ch1.cbz']);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,'me','x','user','password') RETURNING id`, [USER]))[0].id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  return { app, q, uid, auth: { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` } };
}

test('wrapped buckets by the UTC calendar year, and reports a dense year', { skip }, async (t) => {
  const { app, q, uid, auth } = await setup();

  // If either of these ever stops being true the tests below still pass, but they stop testing anything --
  // so they are asserted rather than assumed.
  const tz = (await q<{ TimeZone: string }>('SHOW timezone'))[0].TimeZone;
  assert.equal(tz, 'America/New_York', 'the database session must not be in UTC or this file proves nothing');
  assert.equal(new Date('2026-01-01T00:30:00Z').getMonth(), 11, 'the process must not be in UTC either');

  const ev = (at: string) => q(
    `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
     VALUES ($1,$2,$3,1,true,$4)`, [uid, SERIES, `b_${SERIES}`, at]);
  const wrapped = async (year: number) =>
    (await app.inject({ method: 'GET', url: `/api/wrapped?year=${year}`, headers: auth })).json();

  try {
    await ev(NYE);
    await ev(NYD);

    await t.test('each instant lands in the UTC year it belongs to', async () => {
      assert.equal((await wrapped(2025)).chapters, 1, '2025 should hold only the 23:30 UTC event');
      assert.equal((await wrapped(2026)).chapters, 1, '2026 should hold only the 00:30 UTC event');
    });

    await t.test('byDay is dense, one slot per day, index 0 = 1 January', async () => {
      // Reintroduce by returning only the days that had events: the client has to invent the gaps, which is
      // exactly what made the profile chart lie before statsShape.int.test.ts was written.
      const w = await wrapped(2025);
      assert.equal(w.byDay.length, 365, '2025 is not a leap year');
      assert.equal(w.byDay[364], 1, '31 December is the last slot');
      assert.equal(w.byDay.reduce((a: number, b: number) => a + b, 0), 1);
      assert.equal((await wrapped(2024)).byDay.length, 366, '2024 is a leap year');
    });

    await t.test('byDow is the whole week, not just its argmax', async () => {
      const w = await wrapped(2025);
      assert.equal(w.byDow.length, 7);
      assert.equal(w.byDow[3], 1, '2025-12-31 was a Wednesday in UTC');
      assert.equal(w.busiestDow, 3, 'the old field must still agree with the new array');
      assert.equal(w.byMonth[11], 1, 'December');
      assert.equal(w.byMonth.reduce((a: number, b: number) => a + b, 0), 1);
    });

    await t.test('THE JS HALF: months and weekdays are UTC too', async () => {
      // 00:30 UTC on 1 January 2026 is 19:30 on 31 December 2025 in New York, so the local getters put this
      // event in December, on a Wednesday, in the previous year's bucket -- while the SQL half, which is
      // already UTC, has handed it to the 2026 query. The two halves disagree inside one response.
      //
      // Reintroduce by changing `getUTCMonth()`/`getUTCDay()` back to `getMonth()`/`getDay()`: byMonth[0]
      // and byDow[4] go to zero and December/Wednesday light up in a year they do not belong to.
      //
      // The 2025 assertions above cannot catch this: 23:30 UTC on 31 December is still December, still a
      // Wednesday, in New York -- so that instant reads the same either way.
      const w = await wrapped(2026);
      assert.equal(w.chapters, 1, 'the SQL half put this event in 2026');
      assert.equal(w.byMonth[0], 1, 'January, not the previous December');
      assert.equal(w.byMonth[11], 0);
      assert.equal(w.byDow[4], 1, '2026-01-01 was a Thursday in UTC');
      assert.equal(w.byDow[3], 0, 'not the Wednesday it is in New York');
      assert.equal(w.byDay[0], 1, '1 January is the first slot');
    });

    await t.test('a year with nothing in it answers with zeroes, not with nulls', async () => {
      const w = await wrapped(1999);
      assert.equal(w.chapters, 0);
      assert.equal(w.byDay.length, 365);
      assert.deepEqual(w.byDow, [0, 0, 0, 0, 0, 0, 0]);
      assert.deepEqual(w.topGenreCounts, []);
    });

    await t.test('an absurd ?year= is clamped rather than passed to the date maths', async () => {
      // Assert the ECHOED YEAR, not merely a 200. Every one of these returns 200 with the clamp removed
      // too -- Postgres happily builds a timestamptz for year -5 or 99999 -- so a status-only check was
      // decoration. Reintroduce by dropping the Math.max/Math.min: -5 and 99999 come back unclamped.
      const now = new Date().getUTCFullYear();
      const yearOf = async (y: string) =>
        (await app.inject({ method: 'GET', url: `/api/wrapped?year=${y}`, headers: auth })).json().year;
      assert.equal(await yearOf('-5'), 1970, 'a negative year must clamp to the floor');
      assert.equal(await yearOf('99999'), 9999, 'an absurd year must clamp to the ceiling');
      // Unparseable and zero are ABSENT rather than out of range, so they get the default, not the floor.
      assert.equal(await yearOf('banana'), now);
      assert.equal(await yearOf('0'), now);
    });
  } finally {
    await app.close();
    await q('DELETE FROM reading_events WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  }
});

test('stats takes a window, and reports when reading started', { skip }, async (t) => {
  const { app, q, uid, auth } = await setup();
  const stats = async (qs = '') =>
    (await app.inject({ method: 'GET', url: `/api/stats${qs}`, headers: auth })).json();
  try {
    await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
             VALUES ($1,$2,$3,1,true, now() - interval '3 days')`, [uid, SERIES, `b_${SERIES}`]);

    await t.test('the default is still 90 days', async () => {
      const s = await stats();
      assert.equal(s.days, 90);
      assert.equal(s.byDay.length, 90);
    });

    await t.test('?days= widens the window to a full year', async () => {
      const s = await stats('?days=365');
      assert.equal(s.byDay.length, 365);
      assert.equal(s.byDay.at(-1).day, s.byDay.at(-1).day, 'the last slot is today');
    });

    await t.test('THE CLAMP: ?days= cannot be used to ask for a million rows', async () => {
      // Reintroduce by using the raw query value: `?days=100000000` asks generate_series for a hundred
      // million rows, and the request never returns.
      assert.equal((await stats('?days=100000000')).byDay.length, 400);
      assert.equal((await stats('?days=1')).byDay.length, 7);
      // A negative clamps to the floor rather than falling back to the default: `|| 90` only catches NaN
      // and zero, and -40 is truthy. Either answer would be safe; this pins which one it actually is.
      assert.equal((await stats('?days=-40')).byDay.length, 7);
      // Unparseable IS absent, though, so it gets the default rather than the floor.
      assert.equal((await stats('?days=banana')).byDay.length, 90);
      assert.equal((await stats('?days=0')).byDay.length, 90);
    });

    await t.test('first_read_at is when reading started, and null when it never did', async () => {
      const s = await stats();
      assert.ok(s.first_read_at, 'an account with events must report a first read');
      await q('DELETE FROM reading_events WHERE user_id = $1', [uid]);
      assert.equal((await stats()).first_read_at, null);
    });
  } finally {
    await app.close();
    await q('DELETE FROM reading_events WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  }
});
