/**
 * Turning scraped HTML into plain text, correctly.
 *
 * Every source engine had its own one-line `strip`, and they shared two bugs.
 *
 * ⚠️ WHERE THIS OUTPUT GOES, AND WHY THAT CAPS THE DAMAGE. These strings become series titles, authors and
 * summaries from sites we do not control. They are rendered by React, which escapes, and serialised into
 * the OPDS feed through `esc()` in routes/opds.ts. Nothing in web/ uses `dangerouslySetInnerHTML`. So a tag
 * that survives stripping is cosmetic garbage in a title, NOT stored XSS -- and the day someone adds a
 * `dangerouslySetInnerHTML`, or an OPDS interpolation that skips `esc()`, that stops being true. That is
 * the reason this file is careful rather than clever.
 */

/**
 * Remove HTML tags, repeatedly, until removing them changes nothing.
 *
 * A single pass is not enough. `<scr<b>ipt>` contains no complete tag until the inner `<b>` is taken out,
 * and one pass leaves `<script>` behind -- the tag it was asked to remove, reassembled from its own
 * wreckage. Looping to a fixed point is the whole fix.
 */
export function stripTags(input: string): string {
  let t = input;
  // eslint-disable-next-line no-cond-assign
  for (let guard = 0; guard < 20 && t !== (t = t.replace(/<[^>]*>/g, '')); guard++);
  return t;
}

/**
 * Decode the handful of entities these sites actually emit.
 *
 * ⚠️ `&amp;` LAST. Decoding it first turns `&amp;quot;` into `&quot;`, which the next rule then turns into
 * `"` -- so a source that wanted to show the literal text `&quot;` gets a quote character instead, and one
 * layer of escaping is silently peeled off content we did not author.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Tags out, entities decoded, whitespace collapsed. What a title or summary should look like. */
export function plainText(input: string): string {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}
