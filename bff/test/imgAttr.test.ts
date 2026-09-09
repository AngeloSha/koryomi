// Which attribute of an <img> holds the picture — and why the answer must not depend on attribute order.
//
// A lazy-loading theme puts a spacer in `src` and the real image in `data-src`. The extraction used to be
// written as `/<img[^>]+(?:data-src|src)="([^"]+)"/`, which expresses NO preference: the alternation sits
// inside the pattern, so the winner is decided by regex mechanics and by the order the site emitted its
// attributes. A greedy prefix lands on the last match, a lazy one on the first — and both forms were live in
// this codebase, in different engines, failing in opposite cases.
//
// Measured against real MangaRead markup: some series returned the cover, some returned `Read.gif`, the
// site's own placeholder. It is also the answer to "it worked for months and then suddenly stopped" — the
// site reordered its markup and our extraction flipped, with no change on our side.
//
// ⚠️ EVERY CASE BELOW IS ASSERTED IN BOTH ATTRIBUTE ORDERS. A test that fixes one order is passed by the
// very bug it is supposed to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickImgUrl, pickImgUrlIn, pickAllImgUrls, dropRepeatedCovers, PLACEHOLDER_MIN, coverSanity } from '../src/lib/sources/imgAttr';

const REAL = 'https://site/wp-content/uploads/2024/01/cover.jpg';
const SPACER = 'https://site/wp-content/uploads/2021/07/Read.gif';

test('the real image wins whichever order the site writes the attributes in', () => {
  // Reintroduce by putting the alternation back inside one regex: exactly one of these two rows breaks,
  // and which one depends on whether the prefix is greedy or lazy.
  assert.equal(pickImgUrl(`<img data-src="${REAL}" src="${SPACER}">`), REAL, 'data-src first');
  assert.equal(pickImgUrl(`<img src="${SPACER}" data-src="${REAL}">`), REAL, 'src first');
});

test('the other lazy attributes themes actually use are understood', () => {
  for (const attr of ['data-lazy-src', 'data-original', 'data-cfsrc']) {
    assert.equal(pickImgUrl(`<img src="${SPACER}" ${attr}="${REAL}">`), REAL, attr);
    assert.equal(pickImgUrl(`<img ${attr}="${REAL}" src="${SPACER}">`), REAL, `${attr} first`);
  }
});

test('srcset beats src, and yields one url rather than the whole descriptor list', () => {
  assert.equal(pickImgUrl(`<img src="${SPACER}" srcset="${REAL} 1x, ${REAL}?2x 2x">`), REAL);
  assert.equal(pickImgUrl(`<img srcset="${REAL} 1x" src="${SPACER}">`), REAL);
});

test('a plain img still works — most pages are not lazy', () => {
  assert.equal(pickImgUrl(`<img src="${REAL}">`), REAL);
  assert.equal(pickImgUrl(`<img class="x" src="${REAL}" alt="y">`), REAL);
});

test("single quotes are not a different bug", () => {
  // Plenty of themes emit src='…'. A rule that only understands double quotes is the same silent miss.
  assert.equal(pickImgUrl(`<img src='${SPACER}' data-src='${REAL}'>`), REAL);
  assert.equal(pickImgUrl(`<img src='${REAL}'>`), REAL);
});

test('an img with nothing usable yields null rather than an empty string', () => {
  assert.equal(pickImgUrl('<img>'), null);
  assert.equal(pickImgUrl('<img src="">'), null);
  assert.equal(pickImgUrl('<img alt="no image here">'), null);
});

test('scoping to a container finds that container’s image, in both orders', () => {
  const html = (order: 'lazy-first' | 'src-first') => `
    <div class="other"><img src="https://site/wrong.jpg"></div>
    <div class="summary_image"><a href="/x">${
      order === 'lazy-first'
        ? `<img data-src="${REAL}" src="${SPACER}">`
        : `<img src="${SPACER}" data-src="${REAL}">`
    }</a></div>`;
  assert.equal(pickImgUrlIn(html('lazy-first'), /class="summary_image"/i), REAL);
  assert.equal(pickImgUrlIn(html('src-first'), /class="summary_image"/i), REAL);
  assert.equal(pickImgUrlIn('<p>no images</p>', /class="summary_image"/i), null);
});

test('every image in a page is picked by the same rule', () => {
  const html = `<img src="${SPACER}" data-src="${REAL}"><img data-src="${REAL}?2" src="${SPACER}">`;
  assert.deepEqual(pickAllImgUrls(html), [REAL, `${REAL}?2`]);
});

test('a cover shared by three series is dropped; two is left alone', () => {
  // ⚠️ Dropping is the REPAIR. A listing where every card carries one picture is a listing whose covers we
  // failed to parse; showing it is a confident lie, and returning nothing lets the real fallbacks work.
  // Reintroduce by returning the items untouched: the wall of one repeated image comes back.
  const three = dropRepeatedCovers([
    { sourceId: 'a', coverUrl: SPACER }, { sourceId: 'b', coverUrl: SPACER },
    { sourceId: 'c', coverUrl: SPACER }, { sourceId: 'd', coverUrl: REAL },
  ]);
  assert.deepEqual(three.map((x) => x.coverUrl), [undefined, undefined, undefined, REAL]);

  // Two is a duplicate listing, which happens for real — the same title indexed twice, or a spin-off
  // sharing key art. Not evidence of anything.
  const two = dropRepeatedCovers([
    { sourceId: 'a', coverUrl: SPACER }, { sourceId: 'b', coverUrl: SPACER }, { sourceId: 'c', coverUrl: REAL },
  ]);
  assert.deepEqual(two.map((x) => x.coverUrl), [SPACER, SPACER, REAL]);
  assert.equal(PLACEHOLDER_MIN, 3);
});

test('a listing with no repeats is returned untouched', () => {
  const items = [{ sourceId: 'a', coverUrl: REAL }, { sourceId: 'b', coverUrl: `${REAL}?2` }];
  assert.equal(dropRepeatedCovers(items), items, 'the same array, not a copy, when nothing changed');
});

test('missing covers are not counted as a repeat of each other', () => {
  // Three series with NO cover must not be read as "three series sharing one cover".
  const items = [{ sourceId: 'a' }, { sourceId: 'b' }, { sourceId: 'c' }, { sourceId: 'd', coverUrl: REAL }];
  assert.deepEqual(dropRepeatedCovers(items).map((x) => x.coverUrl), [undefined, undefined, undefined, REAL]);
});

test('the cover check spots the two parsers disagreeing', () => {
  // ⚠️ THE SIGNAL THAT WOULD HAVE CAUGHT THE MANGAREAD BUG WITHOUT A USER REPORT. The listing path and the
  // detail path are different code; when they return different pictures for the SAME series, one is wrong.
  // Reintroduce by comparing only the listing against itself: this returns ok and the bug stays invisible.
  const listing = [{ sourceId: 's1', coverUrl: REAL }, { sourceId: 's2', coverUrl: `${REAL}?2` }];
  const bad = coverSanity(listing, { sourceId: 's1', coverUrl: SPACER });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /disagree/);

  assert.equal(coverSanity(listing, { sourceId: 's1', coverUrl: REAL }).ok, true, 'agreement is not a fault');
});

test('the cover check spots one picture on many cards', () => {
  const all = [1, 2, 3, 4].map((n) => ({ sourceId: `s${n}`, coverUrl: SPACER }));
  const v = coverSanity(all, null);
  assert.equal(v.ok, false);
  assert.match(v.detail, /share one cover/);
});

test('the cover check spots a listing that lost its covers entirely', () => {
  const v = coverSanity([{ sourceId: 'a' }, { sourceId: 'b' }], null);
  assert.equal(v.ok, false);
  assert.match(v.detail, /none with a usable cover/);
});

test('an extension engine cover on a private address is NOT reported broken', () => {
  // ⚠️ Reintroduce by judging URLs with `fetchableCoverUrl`: it refuses private addresses, an extension
  // engine serves its covers FROM one, and every `sw:*` source is reported broken -- the v0.26.2 bug
  // rebuilt inside the watchdog.
  const engine = [
    { sourceId: 'a', coverUrl: 'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail' },
    { sourceId: 'b', coverUrl: 'http://yomi-suwayomi:4567/api/v1/manga/2/thumbnail' },
  ];
  assert.equal(coverSanity(engine, null).ok, true);
});

test('a healthy listing is quiet', () => {
  const v = coverSanity([{ sourceId: 'a', coverUrl: REAL }, { sourceId: 'b', coverUrl: `${REAL}?2` }], null);
  assert.equal(v.ok, true);
  assert.match(v.detail, /2\/2/);
});
