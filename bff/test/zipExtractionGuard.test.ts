// We never EXTRACT a zip with adm-zip — and this test is what keeps that true.
//
// Dependabot reports GHSA on adm-zip: extraction follows destination symlinks, so an archive containing a
// symlink entry can overwrite files outside the target directory. There is no patched version, so the alert
// stays open forever and the only honest response is "the vulnerable code path is not used".
//
// ⚠️ THAT SENTENCE IS A CLAIM, AND A CLAIM IN A SECURITY DISMISSAL HAS TO BE ENFORCED OR IT ROTS. Today we
// only ever CREATE archives — `addFile`, `addLocalFile`, `toBuffer` — when building a CBZ for download or an
// OPDS response. Reading untrusted archives (chapters fetched from the internet) goes through
// `node-stream-zip` in library.ts, which is a different package and a different code path.
//
// The day somebody adds an extraction, the dismissal stops being true and this test says so instead of a
// silence that lasts until the next audit.
// Reintroduce by calling `zip.extractAllTo(dir)` anywhere under bff/src: this fails and names the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;

/** Every .ts file under bff/src. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('nothing in bff/src extracts a zip to disk', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const body = readFileSync(file, 'utf8');
    // The two adm-zip methods that follow symlinks in the destination.
    if (/\.extractAllTo\s*\(|\.extractEntryTo\s*\(/.test(body)) {
      offenders.push(file.slice(SRC.length + 1));
    }
  }
  assert.deepEqual(offenders, [],
    'adm-zip extraction follows destination symlinks and has no patched release. If this is now needed, '
    + 'extract to a fresh temp directory with a path check per entry, and re-assess the Dependabot dismissal.');
});

test('adm-zip is only ever used to build archives', () => {
  // The narrower statement the dismissal actually rests on: every adm-zip call we make is a write.
  const WRITES = /\.(addFile|addLocalFile|addLocalFolder|writeZip|toBuffer)\s*\(/;
  const users = walk(SRC).filter((f) => /require\(['"]adm-zip['"]\)|from ['"]adm-zip['"]/.test(readFileSync(f, 'utf8')));
  assert.ok(users.length > 0, 'if adm-zip is gone entirely, delete this test with it');
  for (const file of users) {
    const body = readFileSync(file, 'utf8');
    assert.ok(WRITES.test(body), `${file.slice(SRC.length + 1)} imports adm-zip but never writes with it — what is it doing?`);
  }
});
