// The library after the browse tab was folded into it.
//
// The library used to spread its controls across three horizontally-scrolling chip rails in its header --
// four sorts, a Filters button, an 18+ toggle and a Select toggle in one row of seven, with the library tabs
// above them -- and hold the rest in a hand-rolled copy of the Sheet primitive. The browse tab, meanwhile,
// was a second library: `/browse?genre=X` ran the same search with the same grid geometry as
// `/library?genres=X`, and the only thing it had of its own was the genre wall.
//
// Read from source rather than driven in a browser, like rails.test.ts and queryKeys.test.ts, so these run
// under `npm test` with no server and no browser. The behavioural half lives in test/e2e.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const classNames = (src: string): string[] =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

/**
 * The file with its comments removed.
 *
 * ⚠️ Needed because several of the comments below QUOTE the code they forbid, to explain what the bug was.
 * A scan that cannot tell the two apart fails on its own documentation, which is a good way to end up
 * deleting the explanation to make the test pass.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** Every .tsx under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('the library header has no hand-rolled horizontal rail left', () => {
  // Reintroduce by putting the sort chips back as the header row they were:
  //   <div className="hide-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5"> … </div>
  // On a desktop mouse that offers no input at all -- the bar is deleted by the class and Lenis eats the
  // wheel over a horizontal-only scroller. It is the exact shape rails.test.ts was written against.
  for (const f of ['app/library/page.tsx', 'components/LibraryFilters.tsx']) {
    const found = classNames(code(read(f))).filter((c) => /overflow-x-auto|hide-scrollbar/.test(c));
    assert.deepEqual(found, [], `${f} hand-rolled a horizontal scroller again: ${found.join(' | ')}`);
  }
});

test('the phone filter panel is the shared Sheet, not a copy of it', () => {
  // ⚠️ The copy this replaced looked identical and behaved differently: no `role="dialog"`, no
  // `aria-modal`, no Escape-to-close, and no `data-lenis-prevent` -- so a flick inside the filter list
  // scrolled the grid behind it. Reintroduce by restoring that local FilterSheet: Escape stops working and
  // a screen reader is handed an anonymous <div>.
  const src = read('app/library/page.tsx');
  assert.match(src, /import \{[^}]*\bSheet\b[^}]*\} from '@\/components\/ui'/, 'the library no longer uses the shared Sheet');
  assert.doesNotMatch(src, /fixed inset-0 z-50/, 'the library hand-rolled a modal container again');

  const ui = read('components/ui.tsx');
  for (const need of ['role="dialog"', 'aria-modal', 'data-lenis-prevent', "e.key === 'Escape'"]) {
    assert.ok(ui.includes(need), `Sheet lost ${need}`);
  }
  // The library has a bottom nav bar; the reader, which Sheet was written for, does not.
  // Reintroduce by dropping `overBottomNav`: the last genre in the list sits under the nav, untappable.
  assert.match(src, /<Sheet[\s\S]{0,200}?overBottomNav/, 'the filter sheet no longer clears the bottom nav');
});

test('nothing anywhere still points at the deleted /browse route', () => {
  // Reintroduce by leaving any one of the six links behind -- the sparkle button in the library header was
  // the easiest to miss. In a static export with `trailingSlash: true` and no server rewrites that is a
  // hard 404 plus a Next prefetch error in the console.
  assert.ok(!existsSync(join(ROOT, 'app/browse')), 'app/browse/ is back');
  const offenders: string[] = [];
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]) {
    if (/['"`]\/browse/.test(readFileSync(f, 'utf8'))) offenders.push(f.slice(ROOT.length + 1));
  }
  assert.deepEqual(offenders, [], `these still link to /browse: ${offenders.join(', ')}`);
});

test('every route the browser tests navigate to actually exists', () => {
  // ⚠️ THE VACUITY GUARD, and it is not hypothetical: deleting app/browse/page.tsx while leaving '/browse'
  // in layout.mjs PASSES today. `page.goto(...).catch(() => {})` swallows the failure, and a 404 body has
  // fewer than 12 painted elements, so the fill rule reports "too little on screen to judge width" and
  // calls it ok. A page list that names a route which does not exist is a test measuring a 404.
  // Reintroduce by adding '/browse' back to PAGES in layout.mjs.
  const listed = new Set<string>();
  const pages = /const PAGES = \(process\.env\.PAGES \|\| '([^']+)'/.exec(read('test/e2e/layout.mjs'));
  assert.ok(pages, 'could not find PAGES in layout.mjs — this check just went blind');
  for (const p of pages![1].split(',')) listed.add(p.trim());
  for (const m of read('test/e2e/run.mjs').matchAll(/\['[a-z]+', '(\/[a-z/]*)'\]/g)) listed.add(m[1]);
  assert.ok(listed.size >= 6, `only ${listed.size} routes scanned — the scan itself is broken`);

  for (const p of listed) {
    const f = p === '/' ? 'app/page.tsx' : `app${p.replace(/\/$/, '')}/page.tsx`;
    assert.ok(existsSync(join(ROOT, f)), `${p} is in an e2e page list but ${f} does not exist — that test measures a 404`);
  }
});

test('no sort the grid cannot page through', () => {
  // ⚠️ `sortSql()` supports `random`, and exposing it would look like it works. It maps to `ORDER BY
  // random()`, the grid pages with LIMIT/OFFSET, and useInfiniteQuery APPENDS -- so page 2 re-rolls the
  // shuffle, redrawing series already scrolled past and silently omitting others. You would have to count
  // to notice. "Surprise me" is the honest version: one series, one request, no pagination.
  // Reintroduce by adding { key: 'random', label: 'Shuffle', sort: 'random,desc' } to SORTS.
  const sorts = [...read('components/LibraryFilters.tsx').matchAll(/sort: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(sorts.length >= 4, `the SORTS scan found ${sorts.length} entries — it is not reading the array`);
  for (const s of sorts) {
    assert.doesNotMatch(s, /random/i, `"${s}": a random order cannot be paginated, and the grid paginates`);
  }
});

test('the genre list comes from the counted endpoint, not the flat one', () => {
  // ⚠️ TWO reasons, and the second is a correctness bug rather than a feature.
  //  1. `/api/genres/overview` is what carries the counts and the cover ids the browse wall was made of.
  //  2. `/api/genres` is `SELECT DISTINCT g` -- RAW spellings -- while the filter matches
  //     `lower(g) = lower($n)`. On the library this was written against that is 100 distinct strings for 93
  //     genres: "Martial arts" and "Martial Arts" render as two chips that are one filter, and picking
  //     either returns the same 76 series. `genreOverview` groups case-insensitively, so this cannot happen.
  // Reintroduce by pointing the panel back at '/api/genres': the counts and mosaics vanish and the seven
  // duplicate pairs come back.
  const src = read('components/LibraryFilters.tsx');
  assert.match(src, /'\/api\/genres\/overview\?covers=4'/, 'the panel is not reading the counted genre endpoint');
  assert.match(src, /queryKey: \['genres-overview'\]/, 'the query key no longer matches the endpoint');
  assert.doesNotMatch(src, /'\/api\/genres'/, 'the flat, case-duplicating genre list is back');
});

test('a genre selected under a different spelling still reads as selected', async () => {
  // ⚠️ The url and the facet label can legitimately disagree about capitalisation, because the SERVER folds
  // and the two lists do not come from the same query. On this library `SELECT DISTINCT g` yields 100
  // strings for 93 genres -- seven pairs differing only in case -- and any link shared before this change
  // can carry either spelling.
  // Reintroduce by comparing with `===`: /library?genres=Martial%20arts draws the Martial Arts row
  // unselected, tapping it appends a SECOND copy, and the pill above the grid cannot clear it.
  const { sameGenre } = await import('../lib/genres');
  assert.equal(sameGenre('Martial arts', 'Martial Arts'), true);
  assert.equal(sameGenre('Slice of life', 'Slice of Life'), true);
  assert.equal(sameGenre(' Horror ', 'horror'), true, 'a stray space from a hand-edited url is not a genre');
  assert.equal(sameGenre('Horror', 'Historical'), false, 'different genres stay different');
  assert.equal(sameGenre('', 'Horror'), false);

  // And the panel must actually use it rather than an exact match.
  const src = read('components/LibraryFilters.tsx');
  assert.match(src, /sameGenre/, 'the panel compares genres exactly again');
  assert.doesNotMatch(code(src), /genres\.includes\(/, 'an exact-match genre comparison came back');
});

test('formats are still separated from genres', () => {
  // Manhwa carries 161 of 2,132 series here, so under a count ranking it outranks every actual mood while
  // saying nothing about what a book is like. Browse quarantined these; that judgement had to survive the
  // page being deleted. Reintroduce by dropping the FORMAT_KEYS split: Manhwa sits between Horror and Isekai
  // at the top of the genre list.
  const src = read('components/LibraryFilters.tsx');
  assert.match(src, /FORMAT_KEYS/, 'the format/genre separation went with the browse page');
  assert.ok(read('lib/genres.ts').includes('FORMAT_KEYS'), 'lib/genres.ts lost FORMAT_KEYS');
});

test('every label the panel renders reaches the translation extractor', () => {
  // The extractor cannot see a label rendered as `tr(x.label)`, only inline literals -- which is what
  // `keys()` is for, and which has already shipped untranslated labels three times here.
  // ⚠️ The statuses in particular used to be rendered as `v.charAt(0) + v.slice(1).toLowerCase()`, i.e. in
  // English, in all eight languages, forever, with nothing in the suite noticing.
  // Reintroduce by going back to that expression, or by dropping a key from the locale files.
  const src = read('components/LibraryFilters.tsx');
  for (const arr of ['SORT_LABELS', 'READ_LABELS', 'STATUS_LABELS']) {
    assert.match(src, new RegExp(`const ${arr} = keys\\(`), `${arr} is not registered with keys()`);
  }
  assert.doesNotMatch(code(src), /charAt\(0\) \+ /, 'a label is being title-cased in JS instead of translated');

  const es = JSON.parse(read('public/locales/es.json'));
  for (const label of ['Ongoing', 'Completed', 'Hiatus', 'Cancelled', 'Sort by', 'Read state', 'Status',
                       'Genres', 'Format', 'Find a genre', 'Sorted by {name}', 'filtered']) {
    assert.ok(label in es, `"${label}" renders through tr() but is in no locale file`);
  }
});

test('every locale file carries the same keys', () => {
  // The suite has no en.json -- English is the source string -- so i18n.mjs builds the required set from
  // es.json and checks the rest against it. A string added to one file and not the other seven fails there,
  // in a browser run; this says so in a unit test instead.
  const dir = join(ROOT, 'public/locales');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8, `expected 8 locale files, found ${files.length}`);
  const es = new Set(Object.keys(JSON.parse(read('public/locales/es.json'))));
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const missing = [...es].filter((k) => !(k in d));
    const empty = [...es].filter((k) => d[k] === '');
    assert.deepEqual(missing, [], `${f} is missing ${missing.length} keys, e.g. ${missing.slice(0, 3).join(', ')}`);
    assert.deepEqual(empty, [], `${f} has ${empty.length} empty translations`);
  }
});

test('no responsive step that can never apply', () => {
  // ⚠️ THIS SHIPPED AND NOTHING NOTICED. Tailwind v4 emits every arbitrary `min-[…]` variant BEFORE the
  // named breakpoints, so on a 1920px display `2xl:grid-cols-9` (96rem) came later in the stylesheet and
  // beat `min-[1800px]:grid-cols-10` sitting right beside it. That combination was written in four grids --
  // library, search (twice) and discover -- and the tenth column had never once appeared. Measured in a
  // browser at 2560px: seven columns where the class list says ten.
  //
  // Nothing failed, because a grid one step short of its own source still looks like a grid. The fix is
  // `--breakpoint-3xl` / `--breakpoint-4xl` in globals.css: a NAMED breakpoint sorts by value with the rest.
  // Reintroduce by writing `min-[1800px]:grid-cols-10` next to a `2xl:` class again.
  const css = read('app/globals.css');
  for (const bp of ['--breakpoint-3xl', '--breakpoint-4xl']) {
    assert.ok(css.includes(bp), `${bp} is gone — the grids past 2xl have no working breakpoint`);
  }
  const NAMED = /\b(?:sm|md|lg|xl|2xl|3xl|4xl):([a-z-]+)-/;
  const offenders: string[] = [];
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]) {
    for (const cls of classNames(code(readFileSync(f, 'utf8')))) {
      // The property an arbitrary min-[] variant sets, e.g. `min-[1800px]:grid-cols-10` -> `grid-cols`.
      for (const m of cls.matchAll(/min-\[[0-9]+px\]:([a-z-]+?)-[a-z0-9-]+/g)) {
        const prop = m[1];
        // …clashes with any NAMED variant in the same class list touching the same property.
        const named = [...cls.matchAll(new RegExp(`\\b(?:sm|md|lg|xl|2xl|3xl|4xl):${prop}-`, 'g'))];
        if (named.length) offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0]} is overridden by a named breakpoint on the same property`);
      }
    }
  }
  assert.ok(NAMED.test('lg:grid-cols-5'), 'the named-variant pattern itself stopped matching');
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the library filter state is still the URL, with one writer', () => {
  // Filters live in the URL so they survive the back button, can be shared, and are part of the react-query
  // key -- changing one refetches from page 0 rather than appending to a stale list. The panel is a pure
  // component over props for the same reason: two writers would race.
  // Reintroduce by giving LibraryFilters its own useSearchParams/useRouter: the sidebar and the sheet then
  // disagree about what is selected the moment one of them navigates.
  const panel = read('components/LibraryFilters.tsx');
  assert.doesNotMatch(panel, /useSearchParams|useRouter/, 'the filter panel writes the URL itself');
  const page = read('app/library/page.tsx');
  assert.equal((page.match(/router\.replace\(/g) ?? []).length, 2,
    'expected exactly two URL writers in the library: setParam and clearAll');
});
