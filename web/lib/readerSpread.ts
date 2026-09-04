/**
 * Which pages share a slide in double-page mode.
 *
 * Lifted out of an inline `useMemo` in the reader so the rules can be tested without mounting an 800-line
 * component and faking a scroll container.
 *
 * The rules, in the order they are applied:
 *
 *  1. **Not in spread mode** — one page per slide. Nothing else applies.
 *  2. **The first page of a chapter is solo.** The manga convention: page 1 is a cover, and pairing it with
 *     page 2 puts every later pair off by one relative to how the book was drawn.
 *  3. **Pages never pair across chapters.** Continuous reading loads the next chapter into the same flat
 *     list, and a slide holding the last page of one chapter and the first of the next belongs to neither.
 *  4. **A wide page is solo**, and so is the page *before* it. A double-page spread scanned as one landscape
 *     image is already two pages wide; putting it beside a portrait page halves it. Giving the page before it
 *     its own slide is what keeps the rest of the chapter paired the way it was drawn -- without that, every
 *     pair after the first spread is off by one, which is the whole reason this rule exists.
 *  5. **Unknown dimensions pair as portrait.** `page_dims` is populated by a backfill that has not
 *     necessarily reached every book, and Komga-backed chapters may carry none at all. Treating unknown as
 *     wide would silently drop those chapters to single-page, which is the more visible wrong answer; it also
 *     matches the reader's own `colW * 1.4` fallback height, which assumes portrait for the same reason.
 */
export interface SpreadItem {
  /** Chapter index in the flat list; pages only pair within one chapter. */
  ci: number;
  firstOfChapter: boolean;
  width?: number | null;
  height?: number | null;
}

/** A page wider than it is tall. Unknown or nonsensical dimensions are portrait -- see rule 5. */
export function isWide(it: SpreadItem | undefined): boolean {
  if (!it) return false;
  const { width: w, height: h } = it;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 && w > h;
}

export function pairSlides(items: SpreadItem[], spread: boolean): { slides: number[][]; slideOf: number[] } {
  const slides: number[][] = [];

  if (!spread) {
    for (let k = 0; k < items.length; k++) slides.push([k]);
  } else {
    let k = 0;
    while (k < items.length) {
      const it = items[k];
      const nxt = items[k + 1];
      const soloed =
        it.firstOfChapter ||          // rule 2
        !nxt || nxt.ci !== it.ci ||   // rule 3
        isWide(it) ||                 // rule 4, the wide page itself
        isWide(nxt);                  // rule 4, the page before a wide one
      if (soloed) { slides.push([k]); k += 1; }
      else { slides.push([k, k + 1]); k += 2; }
    }
  }

  const slideOf: number[] = new Array(items.length);
  slides.forEach((idxs, s) => idxs.forEach((k) => { slideOf[k] = s; }));
  return { slides, slideOf };
}
