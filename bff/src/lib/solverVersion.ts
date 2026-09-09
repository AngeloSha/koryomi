/**
 * Is the Cloudflare solver behind its latest release?
 *
 * The version is already in hand — `solverPing()` reads it out of the solver's own greeting and the health
 * page printed it and threw the rest away. All that was missing was something to compare it to.
 *
 * ⚠️ THIS IS THE ONLY PLACE THE BACKEND TALKS TO GITHUB, and it must never matter that it does. No network,
 * a rate-limited reply, a tag in a shape nobody predicted: every one of those means "no opinion" — never an
 * error, never a status of its own, never a reason for a health check to fail. The solver being current is
 * a nice thing to know; a version check that can take the health page down with it is not.
 *
 * The answer is cached for a day, because a health page that hits GitHub on every load is a rate-limit
 * incident waiting to happen: unauthenticated requests get 60 an hour per IP, shared with everything else on
 * the host.
 */

const LATEST_URL = 'https://api.github.com/repos/FlareSolverr/FlareSolverr/releases/latest';
const TTL_MS = 24 * 60 * 60_000;
/** Long enough to be worth having, short enough that a hanging GitHub cannot hold a health check open. */
const TIMEOUT_MS = 4000;

let cached: { at: number; version: string | null } | null = null;

/** `v3.5.0` / `3.5.0` -> [3,5,0]. Null for anything that is not three plain numbers. */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is `running` strictly older than `latest`?
 *
 * ⚠️ Returns false whenever either side cannot be parsed, which is the safe direction: an unrecognised
 * version string must read as "nothing to say", not as "you are out of date". A solver on a newer build than
 * the last GitHub release — a release candidate, or a fork — is also not behind.
 * Reintroduce by comparing the strings directly: '3.10.0' sorts before '3.5.0' and a current solver is
 * reported as stale.
 */
export function isBehind(running: string | null | undefined, latest: string | null | undefined): boolean {
  const a = parseVersion(running);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/** The newest published FlareSolverr release, or null if we could not find out. Never throws. */
export async function latestSolverVersion(now = Date.now()): Promise<string | null> {
  if (cached && now - cached.at < TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const r = await fetch(LATEST_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'uchiyomi' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A rate-limited or unavailable GitHub is a normal Tuesday, not a fault to report.
    if (r.ok) {
      const j = (await r.json()) as { tag_name?: unknown };
      if (typeof j?.tag_name === 'string' && parseVersion(j.tag_name)) version = j.tag_name;
    }
  } catch {
    /* offline, blocked, timed out — all mean "no opinion" */
  }
  // Cached either way, INCLUDING a null. Otherwise an unreachable GitHub is retried on every single health
  // page load, which is the rate-limit problem this cache exists to avoid, only worse.
  cached = { at: now, version };
  return version;
}

/** Test seam: drop the memoised answer. */
export function resetSolverVersionCache(): void {
  cached = null;
}
