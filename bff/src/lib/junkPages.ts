import { q } from './db';
import { junkHashes } from './pageHash';

/**
 * Which pages of a chapter are furniture rather than story.
 *
 * The evidence is gathered from the whole SERIES -- a credit page is only recognisable as one because it
 * recurs across chapters -- and then applied to the single chapter being read. See `pageHash.ts` for why
 * the scope is one series and why the threshold is three chapters.
 *
 * ⚠️ A person's decision wins, in both directions, and is never recomputed away. `override = true` marks a
 * page junk that the count never reached (a one-off advert, which by definition appears once and so can
 * never repeat); `override = false` rescues a page the count got wrong. That is the escape hatch that makes
 * an automatic skip safe to turn on: anything it gets wrong can be corrected permanently, by hand, in one
 * tap. Reintroduce by applying the heuristic after the override instead of before, and a page you
 * un-flagged is silently re-flagged on the next run of the hash job.
 */
export async function junkPagesFor(bookId: string): Promise<Set<number>> {
  const rows = await q<{ book_id: string; page: number; hash: string | null; override: boolean | null }>(
    `SELECT p.book_id, p.page, p.hash, p.override
       FROM page_hashes p
       JOIN lib_books b ON b.id = p.book_id
      WHERE b.series_id = (SELECT series_id FROM lib_books WHERE id = $1)`,
    [bookId],
  ).catch(() => []);
  if (!rows.length) return new Set();

  const junk = junkHashes(
    rows.filter((r) => r.hash).map((r) => ({ bookId: r.book_id, page: r.page, hash: r.hash as string })),
  );

  const out = new Set<number>();
  for (const r of rows) {
    if (r.book_id !== bookId) continue;
    if (r.override === false) continue;               // rescued by hand: never skip
    if (r.override === true || (r.hash && junk.has(r.hash))) out.add(r.page);
  }
  return out;
}

/** Mark or un-mark one page by hand. `null` hands it back to the heuristic. */
export async function setPageOverride(bookId: string, page: number, override: boolean | null): Promise<void> {
  await q(
    `INSERT INTO page_hashes (book_id, page, override) VALUES ($1, $2, $3)
     ON CONFLICT (book_id, page) DO UPDATE SET override = EXCLUDED.override`,
    [bookId, page, override],
  );
}
