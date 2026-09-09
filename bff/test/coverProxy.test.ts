// The cover proxy fetches our own extension engine, and still refuses everything else on the network.
//
// Suwayomi proxies every cover through itself, so an extension source's cover URL is an absolute URL on the
// engine's own origin — `http://yomi-suwayomi:4567/...`. That resolves to a private address, which is exactly
// what the v0.21.0 SSRF guard exists to refuse, so EVERY cover from EVERY extension source came back as the
// grey placeholder: whole rails of Discover, permanently, cached for a year. Extension icons never had the
// problem only because their route fetches the engine directly and never consults the guard.
//
// ⚠️ THE FIX IS ONE ORIGIN, NOT A CLASS OF ADDRESS, and that is the entire safety argument. `?u=` is
// caller-supplied: a rule like "allow private addresses" would hand back the exact capability v0.21.0
// removed — any signed-in reader turning this route into a scanner of the Docker network. So the interesting
// assertions here are the NEGATIVE ones, and they name real neighbours: the database, the cloud metadata
// service, and an unrelated private host.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

const ENGINE = 'http://yomi-suwayomi:4567';

// ⚠️ THE SHIPPED PREDICATE, imported — not a copy of it restated here. A guard asserted against a
// reimplementation of itself passes no matter what the app actually does.
let isEngineOrigin: typeof import('../src/routes/images').isEngineOrigin;
before(async () => { ({ isEngineOrigin } = await import('../src/routes/images')); });

const onEngineOrigin = (u: string) => isEngineOrigin(u, ENGINE);

test('a cover on the configured engine origin is allowed', () => {
  assert.equal(onEngineOrigin('http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail'), true);
  assert.equal(onEngineOrigin('http://yomi-suwayomi:4567/anything/at/all.png'), true);
});

test('nothing else on the network is', () => {
  // Reintroduce by matching on "is this a private address" instead of "is this the configured origin":
  // every one of these passes, and the cover proxy is a Docker-network scanner again.
  for (const u of [
    'http://yomi-db:5432/',                       // the database, on the same compose network
    'http://169.254.169.254/latest/meta-data/',   // cloud instance metadata
    'http://127.0.0.1:8191/v1',                   // the solver, on loopback
    'http://192.168.1.1/',                        // something else on the operator's LAN
    'http://10.0.0.5/admin',                      // ditto
  ]) {
    assert.equal(onEngineOrigin(u), false, `${u} must never be exempted`);
  }
});

test('a near-miss on the engine origin is not the engine', () => {
  // Origin is scheme + host + PORT. An attacker who can name the host must not inherit the exemption for
  // every port on it, and https:// is a different origin from http:// even for the same name.
  assert.equal(onEngineOrigin('http://yomi-suwayomi:5432/'), false, 'a different port is a different origin');
  assert.equal(onEngineOrigin('https://yomi-suwayomi:4567/'), false, 'a different scheme is a different origin');
  assert.equal(onEngineOrigin('http://yomi-suwayomi.evil.com:4567/'), false, 'a suffix is not the host');
  assert.equal(onEngineOrigin('http://evil.com/?x=http://yomi-suwayomi:4567/'), false, 'nor is a query string');
});

test('a value that is not a URL is never the engine', () => {
  for (const u of ['', 'not a url', '/relative/path.png', 'javascript:alert(1)', 'file:///etc/passwd']) {
    assert.equal(onEngineOrigin(u), false);
  }
});

test('with no engine configured, nothing is exempt', () => {
  // Reintroduce by dropping the `want !== null` check: an unconfigured engine and an unparseable URL both
  // yield null, null === null, and every malformed value on the internet becomes exempt.
  assert.equal(isEngineOrigin('http://yomi-suwayomi:4567/x', ''), false);
  assert.equal(isEngineOrigin('http://yomi-suwayomi:4567/x', undefined as never), false);
  assert.equal(isEngineOrigin('not a url', ''), false, 'two unparseable values must not compare equal');
});
