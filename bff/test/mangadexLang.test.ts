// A MangaDex title with no English chapters could not be added at all.
//
// listChapters asked for `translatedLanguage[]=en` and nothing else, so a title whose scanlations are all
// Spanish or Portuguese answered with zero chapters. Downstream that is indistinguishable from a dead
// series: nothing to add, nothing to download, no error to explain it.
//
// The obvious fix -- drop the language filter -- is wrong here, and this file pins why. Chapter numbers
// repeat across languages, and the dedup keeps whichever entry it happens to see with pages>0; it has no
// notion of a preferred language. So an unfiltered feed yields a list whose language is chosen arbitrarily,
// per chapter. One language at a time, stopping at the first that answers, keeps the result coherent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mangadex } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;

/** Serve a chapter feed only for the languages named, and record every language actually asked for. */
function stubFeed(byLang: Record<string, Array<{ n: number; pages?: number }>>) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const lang = new URL(u).searchParams.get('translatedLanguage[]') ?? '';
    if (!asked.includes(lang)) asked.push(lang);
    const rows = byLang[lang] ?? [];
    return new Response(JSON.stringify({
      total: rows.length,
      data: rows.map((r, i) => ({
        id: `${lang}-ch-${r.n}-${i}`,
        attributes: { chapter: String(r.n), translatedLanguage: lang, pages: r.pages ?? 10, publishAt: '2026-01-01T00:00:00Z' },
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('English is preferred, and nothing else is even asked for when it answers', async () => {
  const asked = stubFeed({ en: [{ n: 1 }, { n: 2 }], 'es-la': [{ n: 1 }] });
  const out = await mangadex.listChapters!('series-1');
  assert.deepEqual(out.map((c) => c.number), [1, 2]);
  assert.ok(out.every((c) => c.lang === 'en'), 'English chapters expected');
  assert.deepEqual(asked, ['en'], 'a title with English chapters must cost exactly one language request');
});

test('THE BUG: a title with no English chapters is no longer empty', async () => {
  // Reintroduce by pinning listChapters back to `translatedLanguage[]=en`: this returns [] and the title
  // cannot be added at all.
  const asked = stubFeed({ 'es-la': [{ n: 1 }, { n: 2 }, { n: 3 }] });
  const out = await mangadex.listChapters!('series-2');
  assert.deepEqual(out.map((c) => c.number), [1, 2, 3]);
  assert.ok(out.every((c) => c.lang === 'es-la'), 'the Spanish chapters should be the ones returned');
  assert.equal(asked[0], 'en', 'English must still be tried first');
  assert.ok(asked.includes('es-la'));
});

test('the result is single-language, never a mixture', async () => {
  // Reintroduce by fetching every language at once (what the obvious fix does): chapter 2 comes back in
  // whichever language the dedup happened to see with pages>0, so the list silently mixes languages.
  const asked = stubFeed({
    'es-la': [{ n: 1 }, { n: 2, pages: 0 }],
    fr: [{ n: 2, pages: 30 }, { n: 3 }],
  });
  const out = await mangadex.listChapters!('series-3');
  const langs = new Set(out.map((c) => c.lang));
  assert.equal(langs.size, 1, `expected one language, got ${[...langs].join(', ')}`);
  assert.equal([...langs][0], 'es-la', 'the first language that answered wins outright');
  assert.ok(!asked.includes('fr'), 'once a language answers, later ones must not be requested');
});

test('the fallback order is fixed, and stops at the first language that answers', async () => {
  const asked = stubFeed({ 'pt-br': [{ n: 7 }] });
  const out = await mangadex.listChapters!('series-4');
  assert.equal(out.length, 1);
  assert.deepEqual(asked, ['en', 'es-la', 'es', 'pt-br'], 'tried in order, and stopped');
});

test('a title with nothing anywhere answers empty rather than looping', async () => {
  const asked = stubFeed({});
  const out = await mangadex.listChapters!('series-5');
  assert.deepEqual(out, []);
  // Bounded: a genuinely empty title must not become an unbounded fan-out on every updater sweep.
  assert.ok(asked.length <= 8, `tried ${asked.length} languages; the list should stay short`);
});

test('a chapter with a non-numeric number is skipped, not NaN-sorted', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    total: 2,
    data: [
      { id: 'a', attributes: { chapter: 'oneshot', translatedLanguage: 'en', pages: 5 } },
      { id: 'b', attributes: { chapter: '4', translatedLanguage: 'en', pages: 5 } },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const out = await mangadex.listChapters!('series-6');
  assert.deepEqual(out.map((c) => c.number), [4]);
});
