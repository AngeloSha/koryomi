/**
 * Which attribute of an `<img>` actually holds the picture.
 *
 * ⚠️ THE RULE IS A PREFERENCE, AND IT HAS TO BE WRITTEN AS ONE. The tempting form —
 *
 *     /<img[^>]+(?:data-src|src)="([^"]+)"/
 *
 * — expresses no preference whatsoever. The alternation is inside the pattern, so which branch wins is
 * decided by regex mechanics and the order the site happened to emit its attributes in:
 *
 *   - a GREEDY prefix (`[^>]+`) backtracks from the end, so it lands on the LAST attribute that matches:
 *     right when `src` comes first, wrong when `data-src` does;
 *   - a LAZY prefix (`[^>]*?`) stops at the FIRST: exactly the opposite.
 *
 * Both were in this codebase, in different engines, failing in opposite cases. Measured against real
 * MangaRead markup: some series returned the cover and some returned `Read.gif`, the site's own lazy-load
 * placeholder — and which you got depended on nothing but attribute order. It is also why covers that had
 * worked for months "suddenly stopped": the site reordered its markup and our extraction silently flipped.
 *
 * So the tag is captured whole, and the attribute is chosen HERE, in one place, in order of trustworthiness.
 * A lazy-loading theme puts a spacer in `src` and the real image in one of the data attributes, so `src` is
 * always the last resort.
 *
 * Reintroduce by inlining the alternation into a single regex again: whichever engine you do it in starts
 * returning placeholders for the attribute order it does not happen to favour.
 */

/** Data attributes that hold the real image on lazy-loading themes, in descending order of trust. */
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-cfsrc'] as const;

/** First URL out of a `srcset`: `"a.jpg 1x, b.jpg 2x"` -> `a.jpg`. */
function firstFromSrcset(v: string): string | null {
  const first = v.split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

/**
 * Pick the image URL out of a whole `<img …>` tag. Null when the tag carries nothing usable.
 *
 * Accepts single or double quotes: plenty of themes emit `src='…'`, and a rule that only understands one
 * of them is the same silent-miss bug wearing different clothes.
 */
export function pickImgUrl(imgTag: string): string | null {
  const attr = (name: string): string | null => {
    const m = imgTag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
    const v = (m?.[1] ?? m?.[2] ?? '').trim();
    return v || null;
  };
  for (const name of LAZY_ATTRS) {
    const v = attr(name);
    if (v) return v;
  }
  const set = attr('data-srcset') || attr('srcset');
  if (set) {
    const first = firstFromSrcset(set);
    if (first) return first;
  }
  return attr('src');
}

/**
 * Find the first `<img>` inside `html` (optionally after `afterPattern`) and pick its URL.
 *
 * The two-step — locate the tag, then choose the attribute — is the whole point: callers must never go back
 * to naming attributes inside their own regex.
 */
export function pickImgUrlIn(html: string, afterPattern?: RegExp): string | null {
  let scope = html;
  if (afterPattern) {
    const at = html.search(afterPattern);
    if (at < 0) return null;
    scope = html.slice(at);
  }
  const tag = scope.match(/<img\b[^>]*>/i)?.[0];
  return tag ? pickImgUrl(tag) : null;
}

/** Every image URL in `html`, in document order, each chosen by the same preference. */
export function pickAllImgUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const u = pickImgUrl(m[0]);
    if (u) out.push(u);
  }
  return out;
}

/**
 * How many distinct series must share one cover URL before it is treated as a placeholder rather than art.
 *
 * THREE. Two series sharing a picture is a duplicate listing, which happens legitimately — the same title
 * indexed twice, or a series and its side-story sharing key art. Three is where coincidence stops being an
 * explanation, and it matches the threshold the repeated-page detector already uses for the same reason.
 */
export const PLACEHOLDER_MIN = 3;

/**
 * Blank the cover on every entry that shares a URL with `PLACEHOLDER_MIN` or more others.
 *
 * ⚠️ Dropping a cover is the REPAIR, not the damage. A listing where twenty cards carry one identical
 * picture is a listing whose covers we failed to parse, and showing that picture twenty times is a confident
 * lie. Returning nothing lets the honest fallbacks take over — AniList art for a series in the library, the
 * first downloaded page after that, and the app's own empty-cover tile otherwise.
 *
 * Applied per listing, because that is the only scope where "the same picture on every card" means anything;
 * two different sources legitimately sharing a CDN image is not evidence of anything.
 * Reintroduce by returning the items untouched: a site that lazy-loads its listing renders as a wall of one
 * repeated image, which is what this looked like before anyone noticed it was a bug.
 */
export function dropRepeatedCovers<T extends { coverUrl?: string; sourceId?: string }>(items: T[]): T[] {
  const seen = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.coverUrl) continue;
    let ids = seen.get(it.coverUrl);
    if (!ids) seen.set(it.coverUrl, (ids = new Set()));
    ids.add(it.sourceId ?? String(ids.size));
  }
  const bad = new Set([...seen].filter(([, ids]) => ids.size >= PLACEHOLDER_MIN).map(([u]) => u));
  if (!bad.size) return items;
  return items.map((it) => (it.coverUrl && bad.has(it.coverUrl) ? { ...it, coverUrl: undefined } : it));
}

/** What a cover check found. `ok: false` is informational — a bad cover never means a broken source. */
export interface CoverVerdict { ok: boolean; detail: string }

/**
 * Do this source's covers look like covers?
 *
 * ⚠️ Free, and that is why it is here rather than in a job of its own: the daily source watchdog already
 * fetches a listing AND a series detail for every source, and throws both away except for counts. Comparing
 * them costs nothing and catches the one bug that took a user report to find.
 *
 * Three signals, in descending order of certainty:
 *
 *  1. THE TWO PARSERS DISAGREE about the same series' cover. A listing and a detail page are parsed by
 *     different code, and when they return different pictures for one series, one of them is wrong. This is
 *     exactly how the MangaRead placeholder shipped: the listing path preferred `data-src` and the detail
 *     path let attribute order decide, so they diverged silently and only some series were affected.
 *  2. ONE COVER ON MANY CARDS — the lazy-load placeholder fingerprint. `dropRepeatedCovers` already repairs
 *     this at parse time, so seeing it here means an engine bypassed the shared helper.
 *  3. NO COVERS AT ALL on a listing that returned results — a whole selector that stopped matching.
 *
 * ⚠️ Deliberately NOT using `fetchableCoverUrl` from the image routes to judge a URL. That predicate refuses
 * private addresses, and an extension engine's covers are ON a private address by design — using it here
 * would report every extension source as broken, which is the v0.26.2 bug rebuilt inside the watchdog. An
 * absolute http(s) URL is all this can honestly check without fetching.
 */
export function coverSanity(
  listing: Array<{ sourceId?: string; coverUrl?: string }>,
  detail?: { sourceId?: string; coverUrl?: string } | null,
): CoverVerdict {
  if (!listing.length) return { ok: true, detail: 'no results to judge' };

  const first = listing[0];
  if (detail && first?.sourceId && detail.sourceId === first.sourceId
      && first.coverUrl && detail.coverUrl && first.coverUrl !== detail.coverUrl) {
    return { ok: false, detail: 'the listing and the series page disagree about this series’ cover — one parser is wrong' };
  }

  const counts = new Map<string, number>();
  for (const it of listing) if (it.coverUrl) counts.set(it.coverUrl, (counts.get(it.coverUrl) ?? 0) + 1);
  const worst = [...counts.values()].reduce((a, b) => Math.max(a, b), 0);
  if (worst >= PLACEHOLDER_MIN) {
    return { ok: false, detail: `${worst} of ${listing.length} results share one cover image — it is a placeholder, not art` };
  }

  const withCover = listing.filter((it) => it.coverUrl && /^https?:\/\//i.test(it.coverUrl)).length;
  if (withCover === 0) return { ok: false, detail: `${listing.length} result(s), none with a usable cover url` };

  return { ok: true, detail: `${withCover}/${listing.length} with covers` };
}
