import { useEffect } from 'react';
import { useStore } from '../lib/store';

const NOTICE_MS = 8000;

/** A short message pinned to the top of the window (e.g. "that file couldn't
 * be opened"). Dismisses itself after a few seconds. */
export default function Notice() {
  const { notice, showNotice } = useStore();

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => showNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, showNotice]);

  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-xl border border-brick/30 bg-paper px-4 py-3 text-sm leading-relaxed text-ink shadow-[0_10px_30px_rgba(34,31,28,0.15)]"
      >
        <p>{notice}</p>
        <button
          type="button"
          onClick={() => showNotice(null)}
          aria-label="Dismiss"
          className="shrink-0 text-ink-soft hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
