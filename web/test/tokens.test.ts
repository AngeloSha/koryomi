// Every colour the app asks for has to exist.
//
// `text-fog-200` and `text-fog-600` were used 65 times across app/ and components/ and were never defined in
// the theme. Tailwind does not warn about that: it simply emits no rule, so all 65 elements inherited their
// parent colour -- which on this app is `fog-50`, near-white. Two thirds of the app's *secondary* text was
// rendering at exactly the same brightness as its primary text, and the result reads as flat rather than as
// broken, so nobody files it as a bug.
//
// This catches the whole class of it: a shade referenced anywhere that the theme does not define.
//
// Under Tailwind v4 the theme is the `@theme` block in app/globals.css, not a config file; this test
// moved with it rather than being deleted, because the bug it guards is not a v3 bug -- v4 emits
// nothing for an undefined shade in exactly the same silent way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * The body of the `@theme { ... }` block, found by COUNTING BRACES rather than with a regex.
 *
 * ⚠️ Tailwind v4 allows `@keyframes` inside `@theme`, and this project has three of them, so the obvious
 * non-greedy `@theme\s*\{([\s\S]*?)\}` reads only as far as the FIRST nested `}`. Today that regex would
 * still pass -- every colour token happens to sit above the keyframes -- which is the dangerous part: it is
 * correct by accident of ordering, not by construction. Reintroduce it AND move one `@keyframes` block
 * above the colours and the whole palette silently disappears ("the ink scale is missing"), which reads as
 * a broken test rather than as a reordered stylesheet. Counting braces does not care where they sit.
 */
function themeBlock(css: string): string {
  const start = css.indexOf('@theme');
  assert.notEqual(start, -1, 'app/globals.css has no @theme block');
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  assert.fail('the @theme block in app/globals.css is never closed');
}

/** The shades the theme actually defines, read from the stylesheet rather than restated here. */
function scales(): Record<string, Set<string>> {
  const theme = themeBlock(readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8'));
  const out: Record<string, Set<string>> = {};
  for (const family of ['ink', 'fog']) {
    const shades = [...theme.matchAll(new RegExp(`--color-${family}-(\\d+)\\s*:`, 'g'))].map((m) => m[1]);
    assert.ok(shades.length, `the ${family} scale is missing from the @theme block in app/globals.css`);
    out[family] = new Set(shades);
  }
  return out;
}

test('no component asks for a colour shade the theme does not define', () => {
  const defined = scales();
  // Any utility that takes a colour: text-, bg-, border-, from-, via-, to-, ring-, fill-, stroke-, divide-,
  // decoration-, outline-, shadow-, accent-, caret-, placeholder-. Optional opacity suffix (`/70`).
  const use = /\b(?:text|bg|border|from|via|to|ring|fill|stroke|divide|decoration|outline|caret|placeholder)-(ink|fog)-(\d+)/g;
  const bad = new Map<string, string[]>();

  for (const file of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')), walk(join(ROOT, 'lib')))) {
    const body = readFileSync(file, 'utf8');
    for (const m of body.matchAll(use)) {
      const [, family, shade] = m;
      if (defined[family].has(shade)) continue;
      const key = `${family}-${shade}`;
      const rel = file.slice(ROOT.length + 1);
      if (!bad.has(key)) bad.set(key, []);
      if (!bad.get(key)!.includes(rel)) bad.get(key)!.push(rel);
    }
  }

  assert.deepEqual(
    [...bad.entries()].map(([k, files]) => `${k} (${files.length} file(s), e.g. ${files[0]})`),
    [],
    'These shades are referenced but not defined in the @theme block of app/globals.css, so Tailwind\n' +
      'emits nothing for them\n' +
      'and the element silently inherits its parent colour. Add the shade to the theme or use one that exists.',
  );
});
