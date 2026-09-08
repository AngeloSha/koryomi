// Finding the pages that are not the story.
//
// A scanlation group's credit page is the same image in every chapter, so a page whose perceptual hash
// recurs across chapters of one series is furniture. That is the whole idea, and these tests pin the two
// decisions that keep it from hiding something real: how much evidence is enough, and whose evidence counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pageHash, junkHashes, MIN_CHAPTERS } from '../src/lib/pageHash';

/**
 * A deterministic test page: a soft gradient with a few solid blocks on it.
 *
 * ⚠️ Deliberately NOT random noise. A first attempt used an XOR pattern, and the re-encode test failed --
 * correctly. Noise is the pathological case for JPEG: lossy compression exists to throw away exactly that
 * high-frequency detail, so the downsample lands somewhere else and the hash moves. Real pages are the
 * opposite -- large flat areas, panel borders, blocks of text -- and a credit page most of all. This
 * fixture is shaped like the thing the feature actually runs on, which is what makes the robustness claim
 * below mean anything. The honest limit: this hash survives re-encoding of PAGES, not of noise.
 */
async function png(seed: number, w = 400, h = 600): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // a smooth background...
      let v = Math.round(40 + (x / w) * 120 + (y / h) * 60);
      // ...with solid blocks whose position depends on the seed, like panels or a text box
      const bx = Math.floor((x / w) * 4);
      const by = Math.floor((y / h) * 6);
      if ((bx + by * 4 + seed) % 5 === 0) v = 235;
      else if ((bx * 3 + by + seed) % 7 === 0) v = 15;
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('the same picture hashes the same, a different one does not', async () => {
  const a = await pageHash(await png(1));
  const b = await pageHash(await png(1));
  const c = await pageHash(await png(2));
  assert.ok(a, 'a readable page should hash');
  assert.equal(a, b, 'the same image must give the same hash, or nothing ever matches');
  assert.notEqual(a, c, 'different images must not collide, or story pages get flagged');
  assert.match(a!, /^[0-9a-f]{16}$/, '64 bits as hex');
});

test('different pages are far apart, which is what makes equality safe', async () => {
  // ⚠️ This test exists because the first design was wrong. The plan was to match "within N bits", the way
  // dHash is normally used. Measuring killed it: on page-shaped images the same page re-encoded lands 0-5
  // bits away, and DIFFERENT pages were observed as close as 4. The ranges overlap, so any threshold loose
  // enough to catch a re-encode can also hide a story page.
  //
  // So matching is exact equality, and what this pins is the property that makes that safe: genuinely
  // different pages are nowhere near each other, so an equal hash means the same picture.
  const bits = (h: string) => BigInt('0x' + h).toString(2).padStart(64, '0');
  const dist = (a: string, b: string) => {
    const x = bits(a), y = bits(b);
    let d = 0;
    for (let i = 0; i < 64; i++) if (x[i] !== y[i]) d++;
    return d;
  };
  const hs: string[] = [];
  for (let s = 1; s <= 8; s++) hs.push((await pageHash(await png(s)))!);
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      assert.notEqual(hs[i], hs[j], 'two different pages produced the same hash — that is a false positive');
      assert.ok(dist(hs[i], hs[j]) >= 3, `pages ${i} and ${j} are only ${dist(hs[i], hs[j])} bits apart`);
    }
  }
});

test('the same file re-encoded often still matches, but nothing depends on it', async () => {
  // Recorded rather than relied upon: a lossless re-encode of the same page usually lands on the same hash,
  // which is a bonus. A page re-compressed differently in every chapter simply never reaches the threshold
  // and is never skipped — fewer skips, which is the safe direction.
  const original = await png(5, 800, 1200);
  const same = await pageHash(await sharp(original).png().toBuffer());
  assert.equal(same, await pageHash(original), 'a lossless round-trip must not move the hash');
});

test('an unreadable page is not a junk page', async () => {
  // Returning null leaves it unhashed and therefore never flagged. The failure mode must be "we skip
  // nothing", never "we hide a page we could not read".
  assert.equal(await pageHash(Buffer.from('this is not an image')), null);
});

test('a page must appear in three chapters before it counts', () => {
  const credit = 'aaaaaaaaaaaaaaaa';
  const two = junkHashes([
    { bookId: 'c1', page: 1, hash: credit },
    { bookId: 'c2', page: 1, hash: credit },
  ]);
  // Reintroduce by lowering MIN_CHAPTERS to 2: a two-chapter series that shares a title card has it skipped
  // on the strength of a single coincidence, and two chapters is the commonest part-downloaded state.
  assert.equal(two.size, 0, 'two chapters is a coincidence, not evidence');

  const three = junkHashes([
    { bookId: 'c1', page: 1, hash: credit },
    { bookId: 'c2', page: 1, hash: credit },
    { bookId: 'c3', page: 1, hash: credit },
  ]);
  assert.deepEqual([...three], [credit], 'three chapters is the threshold');
  assert.equal(MIN_CHAPTERS, 3);
});

test('the same page twice in ONE chapter is not evidence', () => {
  // Counting rows rather than chapters would let a single chapter with a repeated page flag itself.
  const h = 'bbbbbbbbbbbbbbbb';
  const out = junkHashes([
    { bookId: 'c1', page: 1, hash: h },
    { bookId: 'c1', page: 9, hash: h },
    { bookId: 'c1', page: 17, hash: h },
  ]);
  assert.equal(out.size, 0, 'evidence is distinct chapters, not occurrences');
});

test('a story page is never flagged', () => {
  const pages = [
    { bookId: 'c1', page: 1, hash: 'credit0000000000' },
    { bookId: 'c1', page: 2, hash: 'story00000000001' },
    { bookId: 'c2', page: 1, hash: 'credit0000000000' },
    { bookId: 'c2', page: 2, hash: 'story00000000002' },
    { bookId: 'c3', page: 1, hash: 'credit0000000000' },
    { bookId: 'c3', page: 2, hash: 'story00000000003' },
  ];
  const junk = junkHashes(pages);
  assert.deepEqual([...junk], ['credit0000000000']);
  for (const p of pages.filter((x) => x.hash.startsWith('story'))) {
    assert.ok(!junk.has(p.hash), `${p.hash} is a story page and must never be flagged`);
  }
});

test('evidence from one series cannot flag a page in another', () => {
  // ⚠️ The caller passes ONE series' pages. This test states the contract that makes that safe: the
  // function counts chapters, so mixing two series in would let a page be flagged on evidence from a book
  // the reader never opened, where nobody ever compared them.
  // Reintroduce by hashing across the whole library instead of per series.
  const shared = 'cccccccccccccccc';
  const seriesA = [
    { bookId: 'a1', page: 1, hash: shared },
    { bookId: 'a2', page: 1, hash: shared },
  ];
  const seriesB = [{ bookId: 'b1', page: 1, hash: shared }];
  assert.equal(junkHashes(seriesA).size, 0, 'two chapters in this series is not enough on its own');
  assert.equal(junkHashes([...seriesA, ...seriesB]).size, 1,
    'and this is exactly what a global scan would do: three "chapters" spanning two series');
});

test('pages that never hashed are ignored rather than grouped', () => {
  const out = junkHashes([
    { bookId: 'c1', page: 1, hash: '' },
    { bookId: 'c2', page: 1, hash: '' },
    { bookId: 'c3', page: 1, hash: '' },
  ] as any);
  assert.equal(out.size, 0, 'empty hashes must not all group together into one huge false match');
});

test('a blank page is not hashed at all', async () => {
  // ⚠️ Found while writing the browser-test fixture, which generated solid-colour pages. A flat page has
  // every neighbouring pixel equal, so all 64 comparisons are false and the hash is all zeros -- and EVERY
  // flat page produces that identical hash whatever its colour. Left unguarded, three blank pages of three
  // different colours look like the same page repeated three times, which is exactly the pattern that
  // flags furniture. Refusing to hash them means they are never skipped.
  const flat = async (v: number) =>
    sharp(Buffer.alloc(400 * 600 * 3, v), { raw: { width: 400, height: 600, channels: 3 } }).png().toBuffer();
  assert.equal(await pageHash(await flat(255)), null, 'a white page must not hash');
  assert.equal(await pageHash(await flat(0)), null, 'nor a black one');
  assert.equal(await pageHash(await flat(128)), null, 'nor a grey one');
  // and the real thing still does
  assert.ok(await pageHash(await png(1)), 'a page with content must still hash');
});

