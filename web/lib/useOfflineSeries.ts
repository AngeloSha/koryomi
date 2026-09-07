'use client';
import { useEffect, useState } from 'react';
import { downloadedSeriesIds } from './downloads';

/**
 * Which series have something saved on this device, for the little badge on a cover.
 *
 * ⚠️ ONE IndexedDB read per mounted component, not one per card. A library grid renders hundreds of tiles,
 * and asking `isDownloaded()` per tile would be hundreds of round trips to answer one boolean each. The
 * cached set is module-level and shared, so a page full of cards reads the store once.
 *
 * Deliberately not React Query: this is device state, not server state, and it must answer offline where the
 * query client has no persisted cache at all.
 */
let cached: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;

/** Called after anything changes what is stored, so the badges do not lie until the next reload. */
export function invalidateOfflineSeries(): void {
  cached = null;
  inflight = null;
}

export function useOfflineSeries(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => cached ?? new Set());

  useEffect(() => {
    let alive = true;
    if (cached) { setIds(cached); return; }
    inflight = inflight ?? downloadedSeriesIds();
    inflight.then((s) => {
      cached = s;
      if (alive) setIds(s);
    }).catch(() => { /* no store, or a blocked upgrade: no badges, which is the honest answer */ });
    return () => { alive = false; };
  }, []);

  return ids;
}
