'use client';
import { Sheet, useImgRetry } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

export interface GridPage {
  /** Index into the reader's flat page list, which is what a jump actually needs. */
  idx: number;
  number: number;
  src: string | null;
}

/**
 * Thumbnails of the chapter you are in, as a way to jump.
 *
 * **The active chapter only.** Continuous reading appends the next chapter to the same flat list, so by the
 * third chapter the grid would hold six hundred tiles -- and "somewhere in the last three chapters" is not a
 * jump target. The chapter sheet is the control for going further than that.
 *
 * **Tiles at w=200**, which is the width the scrubber already requests. The page endpoint caches per width
 * and each new width is a fresh archive open plus a resize, so reusing a warm width makes this open with
 * thumbnails already on disk instead of paying for a whole new generation of them.
 */
export function PageGrid({ title, pages, current, onPick, onClose }: {
  title: string;
  pages: GridPage[];
  /** Flat index of the page being read, so it can be marked and scrolled to. */
  current: number;
  onPick: (idx: number) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {pages.map((p) => (
          <button
            key={p.idx}
            onClick={() => { onPick(p.idx); onClose(); }}
            aria-label={tr('Open page {n}', { n: p.number })}
            aria-current={p.idx === current ? 'true' : undefined}
            className={`relative overflow-hidden rounded-lg border bg-ink-900 transition
              ${p.idx === current ? 'border-accent ring-1 ring-accent' : 'border-ink-700 hover:border-ink-500'}`}
          >
            <Thumb src={p.src} n={p.number} />
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent pb-0.5 pt-3 text-[10px] font-medium tabular-nums text-white/90">
              {p.number}
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Thumb({ src, n }: { src: string | null; n: number }) {
  const { src: shown, failed, onError } = useImgRetry(src || '');
  if (!src || failed) {
    return <div className="flex aspect-[2/3] w-full items-center justify-center text-[11px] tabular-nums text-ink-500">{n}</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={shown} alt="" onError={onError} loading="lazy" decoding="async"
    className="aspect-[2/3] w-full object-cover object-top" />;
}
