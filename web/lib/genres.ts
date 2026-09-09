/**
 * Genre strings that are not genres.
 *
 * `lib_series.genres` is whatever the scrapers wrote, and `seriesDto` has no tags column to put anything
 * else in (`booksMetadata.tags` is hardcoded `[]`), so formats and site meta-tags end up in the same array
 * as Horror and Romance. On the library this was written against, "Manhwa" carries 159 of 213 series: under
 * a count ranking it is the second-largest tile on the page, above every actual mood. Manhwa is not a mood.
 *
 * So these are separated out and shown as a quiet chip row instead of competing for the wall. They still
 * WORK -- clicking one filters by it exactly as before -- they just stop pretending to be a genre. Nothing
 * is hidden and nothing is deleted; format-ness decides, not size, which is why Manhwa at 159 is a chip and
 * Sports at 2 is a tile.
 *
 * Matched against the case-folded `key` the API returns, so spelling variants collapse on their own.
 */
export const FORMAT_KEYS: ReadonlySet<string> = new Set([
  'manhwa', 'manhua', 'manga', 'webtoon', 'webtoons', 'web comic', 'webcomic', 'long strip',
  'full color', 'full colour', 'one shot', 'one-shot', 'oneshot', 'doujinshi', 'adaptation',
  'animated', 'english', 'mangatoon', 'popular', 'all', 'completed', 'ongoing', 'anthology',
]);

/** One row of `GET /api/genres/overview`. `series` is null in Komga mode, which cannot count. */
export interface GenreFacet {
  key: string;
  label: string;
  series: number | null;
  covers: string[];
}

/**
 * Are these two genre strings the same genre?
 *
 * ⚠️ CASE-FOLDED, BECAUSE THE SERVER FOLDS. The library filter matches `lower(g) = lower($n)`, so
 * `genres=Martial arts` in a url really is filtering by Martial Arts. But `/api/genres/overview` labels each
 * facet with the spelling the library mostly uses, so the url and the label can legitimately disagree —
 * and an exact comparison would draw that row unselected while the grid beside it was filtered by it.
 *
 * This is not hypothetical: on the library this was written against, `SELECT DISTINCT g` returns 100 strings
 * for 93 genres. Seven pairs differ only in case ("Slice of life" / "Slice of Life", "Video games" /
 * "Video Games"), and any shared link or bookmark made before this change can carry either one.
 *
 * Reintroduce by comparing with `===`: open /library?genres=Martial%20arts and the Martial Arts row is
 * drawn unselected, tapping it ADDS a second copy, and the pill above the grid will not clear it.
 */
export function sameGenre(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
