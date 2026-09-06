// MangaDex built-in source — official public API (no key, no scraping, no Cloudflare). The most defensible
// source, so it's bundled in the core and always on. Docs: https://api.mangadex.org/docs/
import { SourceAdapter, SourceSeries, SourceChapter } from './types';

const API = 'https://api.mangadex.org';
const HEADERS = { 'user-agent': 'Uchiyomi/1.0 (self-hosted personal reader)' };
const RATINGS = ['safe', 'suggestive', 'erotica'].map((r) => `contentRating[]=${r}`).join('&');

async function jget(url: string): Promise<any> {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`mangadex ${r.status}`);
  return r.json();
}

function firstLang(obj: any): string {
  if (!obj) return '';
  return obj.en || obj['ja-ro'] || (Object.values(obj)[0] as string) || '';
}

function toSeries(m: any): SourceSeries {
  const a = m.attributes || {};
  const cover = (m.relationships || []).find((r: any) => r.type === 'cover_art');
  const author = (m.relationships || []).find((r: any) => r.type === 'author' || r.type === 'artist');
  const genres = (a.tags || [])
    .filter((t: any) => ['genre', 'theme'].includes(t.attributes?.group))
    .map((t: any) => firstLang(t.attributes?.name))
    .filter(Boolean);
  return {
    sourceId: m.id,
    source: 'mangadex',
    title: firstLang(a.title) || (a.altTitles || []).map((t: any) => firstLang(t)).find(Boolean) || 'Untitled',
    summary: firstLang(a.description),
    status: a.status ? String(a.status).toUpperCase() : undefined,
    genres,
    author: author?.attributes?.name,
    coverUrl: cover?.attributes?.fileName ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes.fileName}` : undefined,
    url: `https://mangadex.org/title/${m.id}`,
    updatedAt: a.updatedAt || a.createdAt || undefined,
  };
}


/**
 * Languages tried, in order, when a title has no English chapters.
 *
 * Deliberately short. Each miss is a request, and a title with chapters in NONE of these is one that was
 * already unusable -- so the list buys the common cases (the Spanish- and Portuguese-language scanlation
 * scene is by far the largest after English) without turning a genuinely empty title into a dozen calls on
 * every updater sweep.
 */
const CHAPTER_LANGS = ['en', 'es-la', 'es', 'pt-br', 'fr', 'ru', 'id'] as const;

/** Every chapter MangaDex lists for one series in one language, paged out and deduped by chapter number. */
async function feedFor(seriesId: string, lang: string): Promise<SourceChapter[]> {
  const all: SourceChapter[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const j = await jget(`${API}/manga/${seriesId}/feed?translatedLanguage[]=${encodeURIComponent(lang)}&order[chapter]=asc&order[volume]=asc&limit=500&offset=${offset}&${RATINGS}`);
    total = j.total ?? 0;
    for (const c of j.data || []) {
      const num = parseFloat(c.attributes?.chapter);
      if (Number.isNaN(num)) continue;
      all.push({ sourceId: c.id, number: num, title: c.attributes?.title || undefined, lang: c.attributes?.translatedLanguage, pages: c.attributes?.pages, publishedAt: c.attributes?.publishAt || c.attributes?.readableAt || undefined });
    }
    offset += 500;
    if (!j.data?.length) break;
  }
  // one entry per chapter number, preferring hosted chapters (pages>0) over external/licensed (pages=0)
  const byNum = new Map<number, SourceChapter>();
  for (const c of all) {
    const ex = byNum.get(c.number);
    if (!ex || ((c.pages || 0) > 0 && (ex.pages || 0) === 0)) byNum.set(c.number, c);
  }
  return [...byNum.values()].sort((a, b) => a.number - b.number);
}

export const mangadex: SourceAdapter = {
  id: 'mangadex',
  name: 'MangaDex',
  // MangaDex hosts every language, but this adapter asks for exactly one: `availableTranslatedLanguage[]=en`
  // in latest() and `translatedLanguage[]=en` in listChapters(). Reporting no language meant it joined every
  // language group, so picking Japanese filled a third of the wall with English MangaDex rows -- which is
  // exactly the "says Japanese, serves English" the owner reported, seen from the reader's side.
  lang: 'en',
  imageReferer: 'https://mangadex.org/', // CDN rejects image fetches without the mangadex referer
  preferredOrder: 10,

  async search(query) {
    const j = await jget(`${API}/manga?title=${encodeURIComponent(query)}&limit=12&${RATINGS}&includes[]=cover_art&includes[]=author&order[relevance]=desc`);
    return (j.data || []).map(toSeries);
  },

  // Browse recently-updated series (no query) — powers the Discover "Newest" view.
  async latest(page = 1) {
    const offset = (Math.max(1, page) - 1) * 24;
    const j = await jget(`${API}/manga?order[latestUploadedChapter]=desc&limit=24&offset=${offset}&hasAvailableChapters=true&availableTranslatedLanguage[]=en&${RATINGS}&includes[]=cover_art&includes[]=author`);
    return (j.data || []).map(toSeries);
  },

  // The same endpoint and the same filters, ordered by how many people follow the series. `toSeries` does
  // not care how the list was sorted, so this is one query parameter and no new parsing.
  async popular(page = 1) {
    const offset = (Math.max(1, page) - 1) * 24;
    const j = await jget(`${API}/manga?order[followedCount]=desc&limit=24&offset=${offset}&hasAvailableChapters=true&availableTranslatedLanguage[]=en&${RATINGS}&includes[]=cover_art&includes[]=author`);
    return (j.data || []).map(toSeries);
  },

  async getSeries(id) {
    const j = await jget(`${API}/manga/${id}?includes[]=cover_art&includes[]=author`);
    return j.data ? toSeries(j.data) : null;
  },

  async listChapters(seriesId) {
    // English first, then a fallback order -- ONE LANGUAGE AT A TIME, never all at once.
    //
    // The bug: this asked only for `translatedLanguage[]=en`, so a title whose chapters are all Spanish or
    // Portuguese came back with zero chapters and could not be added at all. It looked like a dead series.
    //
    // Why not simply drop the filter, which is what the obvious fix does: chapter numbers repeat across
    // languages, and the dedup below keeps whichever entry it happens to see with pages>0 -- it has no
    // notion of a preferred language. Pulling every language at once therefore produces a chapter list
    // whose language is decided arbitrarily, per chapter. Asking one language at a time and stopping at the
    // first that answers keeps the result single-language, so the dedup never has to arbitrate.
    //
    // It also protects the reason this adapter declares `lang: 'en'` at all (see the comment up top):
    // reporting no language made it join every language group, and picking Japanese in the UI then filled a
    // third of the wall with English MangaDex rows.
    for (const lang of CHAPTER_LANGS) {
      const found = await feedFor(seriesId, lang);
      if (found.length) return found;
    }
    return [];
  },

  async getPageUrls(chapterId) {
    const j = await jget(`${API}/at-home/server/${chapterId}`);
    const base = j.baseUrl;
    const hash = j.chapter?.hash;
    const files: string[] = j.chapter?.data || [];
    return files.map((f) => `${base}/data/${hash}/${f}`);
  },
};
