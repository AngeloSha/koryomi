// The pairing rules for double-page mode.
//
// This lived as an inline useMemo in an 800-line component, where the only way to check it was to open a
// chapter and count. The rule that matters most -- a wide page and the page before it each get their own
// slide -- did not exist at all: a landscape double-page spread was pinned beside a portrait page, and every
// pair after it was off by one for the rest of the chapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairSlides, isWide, type SpreadItem } from '../lib/readerSpread';

/** `p` portrait, `w` wide, `?` unknown dimensions; `|` starts a new chapter. */
const parse = (spec: string): SpreadItem[] => {
  const items: SpreadItem[] = [];
  let ci = -1;
  let first = true;
  for (const c of spec) {
    if (c === '|') { ci += 1; first = true; continue; }
    const dims = c === 'p' ? { width: 800, height: 1200 }
      : c === 'w' ? { width: 1600, height: 1200 }
      : { width: null, height: null };
    items.push({ ci, firstOfChapter: first, ...dims });
    first = false;
  }
  return items;
};
const shape = (spec: string, spread = true) =>
  pairSlides(parse(spec), spread).slides.map((s) => s.join('+')).join(' ');

test('single-page mode gives every page its own slide', () => {
  assert.equal(shape('|pppp', false), '0 1 2 3');
});

test('the first page of a chapter is solo, the rest pair', () => {
  assert.equal(shape('|ppppp'), '0 1+2 3+4');
});

test('pages do not pair across a chapter boundary', () => {
  // Reintroduce by dropping the `nxt.ci !== it.ci` term: index 2 pairs with 3, and one slide shows the last
  // page of one chapter beside the first page of the next.
  assert.equal(shape('|ppp|ppp'), '0 1+2 3 4+5');
});

test('THE BUG: a wide page is solo, and so is the page before it', () => {
  // Reintroduce by dropping `isWide(nxt)`: the wide page at index 3 pairs with 2 and gets squeezed to half
  // width, and every pair after it is shifted by one for the rest of the chapter.
  assert.equal(shape('|ppwpp'), '0 1 2 3+4');
});

test('a wide page is solo even when it is the very next page', () => {
  assert.equal(shape('|pwpp'), '0 1 2+3');
});

test('two wide pages in a row are each solo', () => {
  assert.equal(shape('|pwwp'), '0 1 2 3');
});

test('a chapter that is entirely wide pages pairs nothing', () => {
  assert.equal(shape('|wwww'), '0 1 2 3');
});

test('unknown dimensions pair as portrait, not as wide', () => {
  // Reintroduce by treating a missing width/height as wide: every Komga-backed chapter, and every book the
  // dimension backfill has not reached, silently drops to single-page.
  assert.equal(shape('|?????'), '0 1+2 3+4');
  assert.equal(isWide({ ci: 0, firstOfChapter: false, width: null, height: null }), false);
  assert.equal(isWide({ ci: 0, firstOfChapter: false }), false);
});

test('a zero or negative dimension is not wide either', () => {
  // A 0x0 page is a failed probe, not a landscape one. `w > h` alone would call 0x0 portrait but 5x0 wide.
  assert.equal(isWide({ ci: 0, firstOfChapter: false, width: 0, height: 0 }), false);
  assert.equal(isWide({ ci: 0, firstOfChapter: false, width: 5, height: 0 }), false);
});

test('slideOf points every page at the slide that holds it', () => {
  const items = parse('|ppwpp');
  const { slides, slideOf } = pairSlides(items, true);
  assert.equal(slideOf.length, items.length, 'every page must have a slide');
  slideOf.forEach((s, k) => assert.ok(slides[s].includes(k), `page ${k} is not in slide ${s}`));
});

test('an empty chapter list produces no slides and does not throw', () => {
  assert.deepEqual(pairSlides([], true), { slides: [], slideOf: [] });
});
