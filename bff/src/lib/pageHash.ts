import sharp from 'sharp';

/**
 * A perceptual hash of one page, for finding the pages that are not the story.
 *
 * ⚠️ WHY REPETITION AND NOT IMAGE ANALYSIS. A scanlation group's credit page is the SAME IMAGE in every
 * chapter of a series. That is a far stronger signal than trying to decide whether a page "looks like" an
 * advert -- which is a classifier, needs training data, and is wrong in ways nobody can predict. Repetition
 * is arithmetic: real story pages are not the same picture twice, so a page that recurs across chapters is
 * almost certainly furniture. The whole feature rests on that one observation.
 *
 * A dHash rather than a byte checksum: downsample to 9x8 greyscale, then ask 64 times whether a pixel is
 * brighter than the one to its right. Two files that differ only in compression usually land on the same
 * answer, which a checksum never would.
 *
 * ⚠️ MATCHED BY EXACT EQUALITY, NOT BY DISTANCE, and that is a measured decision rather than a simplifying
 * one. dHash is normally used with a Hamming-distance threshold, so the obvious design is "within N bits".
 * Measured on page-shaped images: the same page re-encoded lands 0-5 bits away, and DIFFERENT pages were
 * observed as close as 4 bits apart. Those ranges overlap, so no threshold separates them -- any value
 * loose enough to catch a re-encoded credit page is also loose enough to hide a story page, which is the
 * one failure this feature must never have.
 *
 * Equality has no such risk, and it covers the case that actually occurs: a credit page is the same FILE
 * shipped inside every chapter, not a re-encode of it. What equality gives up is a page that was
 * re-compressed differently in each chapter -- that one is never flagged, so it is simply not skipped.
 * Fewer skips is the correct direction to be wrong in.
 *
 * Returned as a 16-character hex string so it stores and compares as text, which is all the query needs.
 */
export async function pageHash(input: Buffer): Promise<string | null> {
  try {
    // 9 wide, so there are exactly 8 left-to-right comparisons per row, 8 rows, 64 bits.
    // `fit: 'fill'` on purpose: ignoring aspect ratio is what makes the hash survive a rescale.
    const { data } = await sharp(input)
      .resize(9, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // ⚠️ A page with no HORIZONTAL variation carries no identity, and the emphasis is the whole point.
    //
    // Every one of the 64 comparisons below asks whether a pixel is brighter than the one to its RIGHT. So the
    // only variation that can produce a bit is variation ACROSS a row. This check used to measure the global
    // min/max of the whole thumbnail, which sounds equivalent and is not: a long-strip slice that fades from
    // black at the top to white at the bottom has a global range of 255 -- clearing a "range >= 8" test by a
    // factor of thirty -- while every left-to-right pair is identical. All 64 comparisons tie, the hash is all
    // zeros, and every such slice in the library collides with every other.
    //
    // That was not hypothetical: it shipped in v0.25.0 and the all-zero hash alone was skipping 100 pages of a
    // real library, in 800x1280 webtoon slices whose global range was the maximum possible 255.
    //
    // Reintroduce by measuring the global range instead of the per-row range: two DIFFERENT vertical-fade
    // slices then hash identically instead of being refused.
    let widest = 0;
    for (let row = 0; row < 8; row++) {
      let min = 255;
      let max = 0;
      for (let col = 0; col < 9; col++) {
        const v = data[row * 9 + col];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min > widest) widest = max - min;
    }
    if (widest < 8) return null;

    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const i = row * 9 + col;
        bits += data[i] > data[i + 1] ? '1' : '0';
      }
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  } catch {
    // An unreadable page is not a junk page. Returning null leaves it unhashed and therefore never
    // flagged, which is the right way round: the failure mode is "we skip nothing", not "we hide a page".
    return null;
  }
}

/**
 * How many distinct chapters a page must appear in before it counts as furniture.
 *
 * THREE, not two. A two-chapter series that shares a title card would otherwise have it flagged on the
 * strength of a single coincidence, and two is the most common chapter count in a part-downloaded series.
 * Three costs almost nothing in coverage -- a credit page is in every chapter, so it clears three the
 * moment a third chapter exists -- and it removes the whole class of "flagged after one accident".
 *
 * Reintroduce by lowering this to 2 and reading a two-chapter series whose chapters share a cover: the
 * cover is skipped.
 */
export const MIN_CHAPTERS = 3;

/**
 * How many of the 64 comparisons must have found a difference before a hash is allowed to prove two pages are
 * the same. EIGHT.
 *
 * ⚠️ This is the same idea as the guard inside `pageHash`, applied at the other end, and it is here because
 * fixing the guard is not enough on its own. Hashes already written to the database were produced by the OLD
 * guard and are not recomputed -- the backfill only visits chapters it has never seen -- so without this, the
 * degenerate rows keep matching each other for as long as those chapters exist.
 *
 * A hash with k bits set is one where only k of 64 comparisons found any difference; the rest were ties. At
 * k = 0 the hash is literally information-free and cannot identify anything, yet it is shared by every
 * horizontally-uniform page in the library -- measured on a real library, that single value was flagging 100
 * pages. Below 8 the picture is the same in weaker form: near-blank slices that carry too little structure to
 * tell each other apart. Both ends, because a hash of all ones is the same failure photographed in negative.
 *
 * The cost is real and accepted: some genuinely repeated near-blank separators stop being skipped. They are
 * blank slices, so the reader sees an extra sliver of nothing rather than a missing panel -- and that is the
 * direction this feature is supposed to be wrong in.
 *
 * Reintroduce by dropping the `carriesIdentity` filter in `junkHashes`: three different vertical-fade slices,
 * which share the all-zero hash, are again treated as the same page repeated three times.
 */
export const MIN_BITS = 8;

/** Whether a hash says enough about a page to be evidence that two pages are the same one. */
export function carriesIdentity(hash: string | null | undefined): boolean {
  if (!hash) return false;
  let bits = 0;
  for (let i = 0; i < hash.length; i++) {
    let n = parseInt(hash[i], 16);
    if (Number.isNaN(n)) return false;
    while (n) { bits += n & 1; n >>>= 1; }
  }
  return bits >= MIN_BITS && bits <= 64 - MIN_BITS;
}

export interface PageRef { bookId: string; page: number; hash: string }

/**
 * Given every hashed page of ONE series, decide which are furniture.
 *
 * ⚠️ ONE SERIES. Deliberately not global, even though the same group's credit page across different series
 * would be an even stronger signal. Flagging globally means a page can be marked junk in a series whose
 * chapters were never examined -- the evidence lives somewhere the reader cannot see, and a wrong flag
 * there hides a page nobody ever compared. Missing a few skips is a much better failure than that.
 * Reintroduce by passing pages from more than one series: a page is flagged on evidence from another book.
 *
 * Returns the set of hashes that are furniture, not the pages, because the caller stores per page and the
 * same hash can appear more than once in a chapter.
 */
export function junkHashes(pages: PageRef[], minChapters = MIN_CHAPTERS): Set<string> {
  const chaptersByHash = new Map<string, Set<string>>();
  for (const p of pages) {
    if (!carriesIdentity(p.hash)) continue;   // too little structure to prove two pages are the same one
    let seen = chaptersByHash.get(p.hash);
    if (!seen) chaptersByHash.set(p.hash, (seen = new Set()));
    seen.add(p.bookId);
  }
  const out = new Set<string>();
  for (const [hash, books] of chaptersByHash) {
    if (books.size >= minChapters) out.add(hash);
  }
  return out;
}
