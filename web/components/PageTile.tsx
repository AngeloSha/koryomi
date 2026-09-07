'use client';
import Link from 'next/link';
import { img } from '@/lib/api';
import { Img } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

/**
 * One saved manga page, rendered as the page itself.
 *
 * **Fixed 2:3 tiles, not masonry.** `/api/bookmarks` carries no page dimensions, so an honest masonry
 * layout would need a second round trip per tile; guessing instead reflows every column the moment the
 * real heights arrive. A fixed ratio is stable on first paint, and 2:3 is already the card ratio, so a
 * grid of moments and a grid of covers line up.
 *
 * **Width 400.** `/img/books/:id/page/:n` caches per width, and every distinct width is a fresh CBZ open
 * plus a sharp resize plus a new cache generation. The app had exactly one page width before this (200,
 * the reader scrubber) and 400 is the width the cards already request, so this adds no new generation for
 * a cover and reuses a warm one wherever a page has been seen at card size.
 *
 * `object-top` because a portrait manga page cropped to 2:3 from the middle reliably lands on the gutter
 * between panels -- the same reason the cover tiles pass it.
 */
export function PageTile({
  bookId, page, chapter, note, seriesTitle, className = '',
}: {
  bookId: string;
  page: number;
  /** Chapter number as the API reports it -- a string, because "10.5" is a real chapter. */
  chapter?: string | number | null;
  note?: string | null;
  seriesTitle?: string | null;
  className?: string;
}) {
  return (
    <Link
      href={`/reader/?book=${encodeURIComponent(bookId)}&page=${page}`}
      className={`group relative block overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 ${className}`}
      aria-label={tr('Open page {n}', { n: page })}
    >
      <Img
        src={img.page(bookId, page, 400)}
        alt={seriesTitle || ''}
        className="aspect-[2/3] w-full"
        imgClassName="object-top transition-transform duration-500 ease-out group-hover:scale-[1.03]"
      />
      {/* The scrim is part of the tile, not a hover affordance: a page number that only appears on hover is
          invisible on a phone, which is where this page is mostly read. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-6">
        {/* One key, not "Ch." + number + "p." glued together: a translator needs the whole phrase to reorder
            it, and in RTL the fragments would run in source order regardless of the surrounding direction. */}
        <p className="truncate text-[11px] font-medium text-white/95">
          {chapter != null && chapter !== ''
            ? tr('Ch. {c} · p.{n}', { c: String(chapter), n: page })
            : tr('p.{n}', { n: page })}
        </p>
        {note ? <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-white/65">{note}</p> : null}
      </div>
    </Link>
  );
}
