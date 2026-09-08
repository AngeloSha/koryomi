import { join } from 'path';
import { pool, q } from './db';
import { cbzPageAt, LIBRARY_ROOT } from './library';
import { pageHash } from './pageHash';

/**
 * Fill in a perceptual hash for every page, in the background, so the reader can skip the pages that are
 * not the story. Shaped after `fingerprintJob.ts`, which is the established way to walk the whole library
 * without hurting a server that is also answering requests: an advisory lock so two processes cannot both
 * run it, a bounded worker pool, batches with a breath between them, and progress the Tasks panel can read.
 *
 * ⚠️ This opens every chapter archive and decodes every page, which is by far the most expensive job in the
 * app -- more than fingerprinting, which only reads a zip's central directory. Hence the smaller batch, the
 * lower concurrency, and the longer delay after boot. It is also why a page is stamped `checked_at` even
 * when it could not be read: without that, an unreadable page is retried on every pass, forever.
 */
const LOCK = 0x70616765; // 'page'
const BATCH = 40;        // chapters per batch, not pages -- one chapter is tens of decodes
const CONCURRENCY = 2;

export interface PageHashProgress {
  running: boolean;
  chapters: number;
  pages: number;
  failed: number;
  remaining: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  ms: number | null;
}

export const phState: PageHashProgress = {
  running: false, chapters: 0, pages: 0, failed: 0,
  remaining: null, startedAt: null, finishedAt: null, ms: null,
};

/** Chapters with no page hashed yet. Cheap enough for an admin endpoint. */
export async function pageHashRemaining(): Promise<number> {
  const rows = await q<{ n: string }>(
    `SELECT count(*)::text n FROM lib_books b
      WHERE NOT EXISTS (SELECT 1 FROM page_hashes p WHERE p.book_id = b.id)`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function pool_<T>(items: T[], n: number, worker: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

interface Row { id: string; root: string | null; file: string }

/** Hash every page of one chapter. Returns how many pages were read and how many could not be. */
async function hashChapter(b: Row): Promise<{ ok: number; bad: number }> {
  const abs = join(b.root || LIBRARY_ROOT, b.file);
  let ok = 0;
  let bad = 0;
  const rows: Array<[string, number, string | null]> = [];
  for (let i = 0; ; i++) {
    let page: Awaited<ReturnType<typeof cbzPageAt>> = null;
    try {
      page = await cbzPageAt(abs, i);
    } catch {
      break; // the archive itself is unreadable; stop rather than spin
    }
    if (!page) break;
    const h = await pageHash(page.bytes);
    rows.push([b.id, i + 1, h]);
    if (h) ok++; else bad++;
    if (i + 1 >= page.total) break;
  }
  // ⚠️ A chapter that produced NOTHING still has to leave a mark, and this is not tidiness -- without it
  // the job never finishes. The batch query selects chapters with no page_hashes row at all, so a chapter
  // that yields zero pages (an unreadable archive, an empty one) is still unhashed when the next batch is
  // chosen, and is chosen again. Good chapters get rows and drop out; the broken ones accumulate, and the
  // moment they are all that is left the loop spins on them forever at full CPU with nothing to show.
  // ONE such chapter in a library is enough.
  //
  // Page 0 is the mark: not a real page number, so it can never be mistaken for one -- `junkPagesFor`
  // returns page numbers and this row has a null hash and no override, so it is never returned.
  // Reintroduce by dropping this branch: point a lib_books row at a file that does not exist and
  // pageHashRemaining() never reaches 0, however many times the job runs.
  const values = (rows.length ? rows : [[b.id, 0, null] as [string, number, string | null]])
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, now())`).join(',');
  // `override` is deliberately NOT touched: a person's decision about a page outranks the heuristic and
  // must survive every re-run of this job.
  await q(
    `INSERT INTO page_hashes (book_id, page, hash, checked_at) VALUES ${values}
     ON CONFLICT (book_id, page) DO UPDATE SET hash = EXCLUDED.hash, checked_at = now()`,
    (rows.length ? rows : [[b.id, 0, null]]).flat(),
  ).catch(() => {});
  return { ok, bad };
}

/** Hash pages for every chapter not yet looked at. Safe to call repeatedly; safe to interrupt. */
export async function runPageHashBackfill(opts: { max?: number } = {}): Promise<PageHashProgress> {
  const client = await pool.connect();
  let held = false;
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    held = !!got.rows[0]?.ok;
    if (!held) return phState;
  } finally {
    if (!held) client.release();
  }

  phState.running = true;
  phState.startedAt = Date.now();
  phState.finishedAt = null;
  phState.chapters = 0;
  phState.pages = 0;
  phState.failed = 0;
  const limit = opts.max ?? Infinity;

  try {
    for (;;) {
      const batch = await q<Row>(
        `SELECT b.id, b.root, b.file FROM lib_books b
          WHERE NOT EXISTS (SELECT 1 FROM page_hashes p WHERE p.book_id = b.id)
          ORDER BY b.id LIMIT $1`,
        [Math.min(BATCH, Math.max(0, limit - phState.chapters))],
      );
      if (!batch.length) break;

      await pool_(batch, CONCURRENCY, async (b) => {
        const r = await hashChapter(b);
        phState.chapters++;
        phState.pages += r.ok;
        phState.failed += r.bad;
      });

      phState.remaining = await pageHashRemaining().catch(() => null);
      if (phState.chapters >= limit) break;
      await new Promise((r) => setImmediate(r));
    }
    return phState;
  } finally {
    phState.running = false;
    phState.finishedAt = Date.now();
    phState.ms = phState.finishedAt - (phState.startedAt ?? phState.finishedAt);
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
    if (phState.chapters) {
      console.log(`[pagehash] ${phState.chapters} chapters, ${phState.pages} pages, ${phState.failed} unreadable, ${phState.ms}ms`);
    }
  }
}

/**
 * Start well after boot -- later than the fingerprint job, because this one is heavier and there is no
 * hurry: a page that is not hashed yet is simply not skipped.
 */
export function schedulePageHashBackfill(delayMs = 5 * 60_000): void {
  setTimeout(() => {
    void runPageHashBackfill().catch((e) => console.warn('[pagehash] backfill failed', (e as Error)?.message));
  }, delayMs).unref?.();
}
