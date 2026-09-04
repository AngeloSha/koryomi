// Where a downloaded chapter opens, and what happens when you reach the end of what you downloaded.
//
// Two bugs, both invisible online and both certain offline. The reader read its pages from IndexedDB and then
// asked the SERVER where to resume and what the other chapters were — two live calls that cannot succeed on a
// plane. The resume call threw, so `setStartPage(1)`: every downloaded chapter opened at page one, no matter
// how far in you were. The chapter-list call threw too, leaving `chapterRefs` empty, which the append effect
// read as "there is no next chapter" and rendered as "You finished <series>" — a trophy, after every single
// offline chapter, for a series you are three chapters into.
//
// So the store learned to remember the page, and to answer "what else do I hold for this series".
import 'fake-indexeddb/auto';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const A = 'user-aaaa-1111';
const B = 'user-bbbb-2222';

let dl: typeof import('../lib/downloads');
let setCurrentUser: typeof import('../lib/api').setCurrentUser;

/** One manifest per book id, so a series can hold several chapters. */
const MANIFESTS: Record<string, { seriesId: string; number: string; title: string }> = {
  bk1: { seriesId: 's1', number: '1', title: 'Chapter 1' },
  bk2: { seriesId: 's1', number: '2', title: 'Chapter 2' },
  bk9: { seriesId: 's1', number: '9', title: 'Chapter 9' },
  bk10: { seriesId: 's1', number: '10', title: 'Chapter 10' },
  other: { seriesId: 's2', number: '1', title: 'Elsewhere' },
};

globalThis.fetch = (async (url: any) => {
  const u = String(url);
  const m = /\/api\/books\/([^/]+)\/download-manifest/.exec(u);
  if (m) {
    const meta = MANIFESTS[m[1]] || MANIFESTS.bk1;
    return new Response(JSON.stringify({
      seriesId: meta.seriesId, seriesTitle: 'A Series', title: meta.title, number: meta.number,
      pageCount: 2, totalBytes: 20, readingDirection: 'WEBTOON',
      pages: [{ number: 1, url: '/p/1', width: 800, height: 1200 }, { number: 2, url: '/p/2', width: 800, height: 1200 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('/p/')) return new Response(new Blob(['x'.repeat(10)]), { status: 200 });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

/** Reach into the store to arrange a state the public API cannot produce (here: a future timestamp). */
function withRawRecord(bookId: string, edit: (rec: any) => any): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('yomi-offline');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('chapters', 'readwrite');
      const store = tx.objectStore('chapters');
      const get = store.get(`${A}:${bookId}`);
      get.onsuccess = () => { if (get.result) store.put(edit(get.result)); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

before(async () => {
  dl = await import('../lib/downloads');
  ({ setCurrentUser } = await import('../lib/api'));
  await dl.flushOutbox(); // let the app create the schema, not a bare openDB
});
beforeEach(() => { setCurrentUser(A); });

test('a downloaded chapter remembers where you were', async (t) => {
  setCurrentUser(A);
  await dl.downloadChapter('bk1');

  await t.test('THE BUG: the page is recorded alongside the progress ping', async () => {
    // Reintroduce by deleting the noteOfflineProgress call in the reader's sendProgress: the store never
    // learns the page, and every downloaded chapter opens at page 1 with no network.
    await dl.noteOfflineProgress('bk1', 42, false);
    const rec = await dl.getOfflineChapter('bk1');
    assert.equal(rec?.lastPage, 42);
    assert.equal(rec?.lastCompleted, false);
    assert.ok(rec?.lastPageAt && rec.lastPageAt > 0, 'the write must be timestamped, or it cannot be ordered');
  });

  await t.test('a later write wins, and a stale one cannot rewind the reader', async () => {
    await dl.noteOfflineProgress('bk1', 60, false);
    assert.equal((await dl.getOfflineChapter('bk1'))?.lastPage, 60, 'a newer write must apply');

    // Now the ordering guard itself. Progress pings are debounced and can land out of order — a slow tab
    // flushing a queued ping after a fresh one would otherwise drag the position backwards. Stamp the record
    // into the future and confirm a write made "now" is refused.
    // Reintroduce by dropping the lastPageAt comparison in noteOfflineProgress: this write lands and the
    // reader resumes at page 5 instead of 60.
    await withRawRecord('bk1', (rec) => ({ ...rec, lastPageAt: Date.now() + 60_000 }));
    await dl.noteOfflineProgress('bk1', 5, false);
    assert.equal((await dl.getOfflineChapter('bk1'))?.lastPage, 60, 'a stale ping overwrote a newer position');
  });

  await t.test('the rest of the record survives the annotation', async () => {
    const rec = await dl.getOfflineChapter('bk1');
    assert.equal(rec?.seriesId, 's1');
    assert.equal(rec?.pageCount, 2);
    assert.equal(rec?.pages.length, 2);
    assert.equal(rec?.pages[0].width, 800, 'page dimensions must survive — spread detection reads them');
  });

  await t.test('a record written before this field existed still reads', async () => {
    // The whole reason this ships WITHOUT an IndexedDB version bump. Reintroduce by bumping VERSION to add
    // the field: the upgrade can be blocked by the service worker's open connection, and every reader hangs
    // on "Loading chapter…" — which is exactly what v0.11.1 shipped.
    const rec = await dl.getOfflineChapter('bk1');
    const { lastPage, lastPageAt, lastCompleted, ...v1shaped } = rec as any;
    assert.ok(v1shaped.bookId && v1shaped.pages, 'the v1 shape is still a complete, usable record');
  });

  await t.test('annotating a chapter that was never downloaded creates nothing', async () => {
    // Reintroduce by upserting instead of get-then-put: a chapter with no pages appears in Downloads.
    await dl.noteOfflineProgress('never-downloaded', 5, false);
    assert.equal(await dl.getOfflineChapter('never-downloaded'), undefined);
    assert.equal(await dl.isDownloaded('never-downloaded'), false);
  });

  await t.test("and it stays inside the account that downloaded it", async () => {
    setCurrentUser(B);
    assert.equal(await dl.getOfflineChapter('bk1'), undefined, "B must not see A's position");
    await dl.noteOfflineProgress('bk1', 3, false);
    setCurrentUser(A);
    assert.equal((await dl.getOfflineChapter('bk1'))?.lastPage, 60, "B's write must not have touched A's record");
  });
});

test('the reader can list what it holds for a series, in reading order', async (t) => {
  setCurrentUser(A);
  for (const id of ['bk10', 'bk2', 'bk9', 'other']) await dl.downloadChapter(id);

  await t.test('THE BUG: the series has a chapter list offline at all', async () => {
    // Reintroduce by removing the listSeriesDownloads fallback in the reader's load effect: chapterRefs is
    // empty offline, prev/next are both dead, and the append effect reads the empty list as the end of the
    // series — so every offline chapter finishes with "You finished".
    const list = await dl.listSeriesDownloads('s1');
    assert.ok(list.length >= 3, `expected the s1 chapters, got ${list.length}`);
    assert.ok(!list.some((c) => c.seriesId !== 's1'), 'another series leaked into the list');
  });

  await t.test('sorted numerically, not lexicographically', async () => {
    // Reintroduce by sorting on the string: "10" lands before "2" and the reader walks the chapters out of
    // order, which reads as chapters being skipped.
    const nums = (await dl.listSeriesDownloads('s1')).map((c) => c.number);
    assert.deepEqual(nums, ['1', '2', '9', '10'].filter((n) => nums.includes(n)));
  });

  await t.test('a series with nothing downloaded lists nothing', async () => {
    assert.deepEqual(await dl.listSeriesDownloads('s-nothing'), []);
  });
});
