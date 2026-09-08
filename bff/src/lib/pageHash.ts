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

    // ⚠️ A page with no variation carries no identity. A pure-white or pure-black page -- a blank leaf, a
    // separator, a scan that failed to a flat colour -- has every neighbour equal, so every one of the 64
    // comparisons is false and the hash is all zeros. EVERY flat page produces that same hash regardless of
    // its colour, so they would all match each other and get flagged together. Refusing to hash them is the
    // fix: an unhashed page is never skipped.
    // Reintroduce by deleting this check: seed a series with three differently-coloured blank pages and all
    // three are flagged as the same repeated page.
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    if (max - min < 8) return null;

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
    if (!p.hash) continue;
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
