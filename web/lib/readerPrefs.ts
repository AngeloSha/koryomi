export type ReaderTheme = 'amoled' | 'sepia' | 'gray';

/**
 * What the reader does with a page that repeats across chapters -- a credit page, an advert.
 *
 * `collapse` is the default and the interesting one: the page stays exactly where it is in the scroll but
 * renders as a thin band of itself, so the chapter is never secretly shorter than it is and you can see what
 * was set aside before you decide about it. `hide` is the old behaviour, kept for anyone who wants the page
 * gone outright.
 */
export type JunkPages = 'show' | 'collapse' | 'hide';
const JUNK_MODES: readonly JunkPages[] = ['show', 'collapse', 'hide'];

export interface ReaderPrefs {
  gap: number; // px between pages (0 = seamless webtoon)
  brightness: number; // 0.25 .. 1
  mode: 'vertical' | 'paged';
  autoScroll: number; // px/frame, 0 = off
  fitWidth: boolean;
  theme: ReaderTheme;
  spread: boolean; // paged mode: two pages side by side (manga double-page convention)
  junkPages: JunkPages; // what to do with pages that repeat across chapters
  /**
   * @deprecated Superseded by `junkPages`, and kept ONLY so that an older build does not fight this one.
   * Always derived in `normalise`, never read for behaviour. See the note there.
   */
  skipJunk: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  junkPages: 'collapse',
  skipJunk: true,
  gap: 0,
  brightness: 1,
  mode: 'vertical',
  autoScroll: 0,
  fitWidth: true,
  theme: 'amoled',
  spread: false,
};

const KEY = 'yomi_reader_prefs';

// Reader settings follow the account, not the browser: set the reader up on a laptop and your phone should
// already agree. localStorage stays the source for first paint and for reading offline; the server is the
// source of truth once it answers. Writes are debounced because brightness/gap are sliders.
const SYNC_DELAY = 1500;
const SERIES_CAP = 300; // per-series memory is unbounded otherwise — a big library would bloat the settings row
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fill in what a stored object is missing, and reconcile the setting with the boolean it replaced.
 *
 * ⚠️ THE MIGRATION IS THE POINT, and plain `{ ...DEFAULT_PREFS, ...stored }` gets it wrong. Someone who
 * deliberately turned skipping OFF has `{ skipJunk: false }` and no `junkPages` at all, so the spread would
 * hand them the default and silently switch a feature back on that they had switched off. When `junkPages`
 * is absent we read the old boolean instead.
 * Reintroduce by deleting the `skipJunk === false` branch: a stored `{"skipJunk": false}` loads as
 * `'collapse'` and starts collapsing pages for someone who asked it not to.
 *
 * ⚠️ AND `skipJunk` IS STILL WRITTEN, every time. `savePrefs` PUTs the whole `reader` object and the server
 * merges it shallowly, so a second device on an older build would otherwise overwrite the settings row with
 * an object that has no `junkPages` in it -- wiping the choice on every device. Writing both keys means the
 * two builds degrade into each other instead of fighting over the row.
 *
 * Unrecognised values fall back to the default rather than being trusted, because nothing else here
 * validates what came out of storage either.
 */
export function migratePrefs(raw: unknown): ReaderPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReaderPrefs>;
  // ⚠️ Ask the RAW object, not the merged one. The defaults supply a `junkPages`, so a check against the
  // merged object can never fail and the branch below would never run.
  const chosen = JUNK_MODES.includes(r.junkPages as JunkPages);
  const p = { ...DEFAULT_PREFS, ...r };
  if (!chosen) p.junkPages = r.skipJunk === false ? 'show' : DEFAULT_PREFS.junkPages;
  p.skipJunk = p.junkPages !== 'show';
  return p;
}

export function loadPrefs(): ReaderPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    return migratePrefs(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: ReaderPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
  queueSync();
}

/** Debounced push of the local reader state into the user's server-side settings. Failures are ignored —
 *  this is a convenience, and losing a sync must never interrupt reading. */
function queueSync() {
  if (typeof window === 'undefined') return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void import('./api')
      .then(({ api }) => api('/api/settings', { method: 'PUT', json: { reader: loadPrefs(), readerSeries: allSeriesPrefs() } }))
      .catch(() => {});
  }, SYNC_DELAY);
}

/** Pull server-side reader settings on sign-in and adopt them locally. Returns the effective prefs. */
export async function syncPrefsFromServer(): Promise<ReaderPrefs> {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const { api } = await import('./api');
    const s = await api<{ reader?: Partial<ReaderPrefs>; readerSeries?: Record<string, SeriesPrefs> }>('/api/settings');
    if (s?.reader && typeof s.reader === 'object') {
      // Through the same reconciliation as a local read: a settings row written by an older build carries
      // `skipJunk` and no `junkPages`, and must not land here as a raw object.
      localStorage.setItem(KEY, JSON.stringify(migratePrefs({ ...loadPrefs(), ...s.reader })));
    }
    if (s?.readerSeries && typeof s.readerSeries === 'object') {
      for (const [id, sp] of Object.entries(s.readerSeries)) {
        if (id && sp && typeof sp === 'object') {
          localStorage.setItem(`yomi_rs_${id}`, JSON.stringify({ ...loadSeriesPrefs(id), ...sp }));
        }
      }
    }
  } catch { /* offline or signed out — keep whatever is local */ }
  return loadPrefs();
}

/** Every per-series override held locally, capped so the settings row can't grow without bound. */
function allSeriesPrefs(): Record<string, SeriesPrefs> {
  const out: Record<string, SeriesPrefs> = {};
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('yomi_rs_')) keys.push(k);
    }
    for (const k of keys.slice(-SERIES_CAP)) {
      const id = k.slice('yomi_rs_'.length);
      const v = loadSeriesPrefs(id);
      if (Object.keys(v).length) out[id] = v;
    }
  } catch {}
  return out;
}

// ---- per-series memory (mode/theme/zoom remembered per title) ----
export interface SeriesPrefs {
  mode?: ReaderPrefs['mode'];
  theme?: ReaderTheme;
  zoom?: number;
  spread?: boolean;
}

export function loadSeriesPrefs(seriesId: string): SeriesPrefs {
  if (typeof window === 'undefined' || !seriesId) return {};
  try {
    return JSON.parse(localStorage.getItem(`yomi_rs_${seriesId}`) || '{}');
  } catch {
    return {};
  }
}

export function saveSeriesPrefs(seriesId: string, partial: SeriesPrefs) {
  if (!seriesId) return;
  try {
    const cur = loadSeriesPrefs(seriesId);
    localStorage.setItem(`yomi_rs_${seriesId}`, JSON.stringify({ ...cur, ...partial }));
  } catch {}
  queueSync();
}

export const THEME_FILTER: Record<ReaderTheme, string> = {
  amoled: 'none',
  sepia: 'sepia(0.55) saturate(1.15) brightness(0.94)',
  gray: 'grayscale(0.25) brightness(0.88) contrast(0.95)',
};
