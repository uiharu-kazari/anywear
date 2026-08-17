import { useStore } from '../lib/store';

const GLYPH = { wear_it: '✓', maybe: '≈', skip: '✕' } as const;
const COLOR = { wear_it: 'text-sage-deep', maybe: 'text-ochre', skip: 'text-brick' } as const;

export default function Lookbook() {
  const { lookbook, openLookbookEntry } = useStore();
  if (!lookbook.length) return null;
  return (
    <section aria-label="Lookbook">
      <h2 className="tag-label mb-2">lookbook</h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {lookbook.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => openLookbookEntry(e.id)}
            className="group w-24 shrink-0 text-left"
            title={`${e.garmentLabel} — ${e.occasion}`}
          >
            <span className="block overflow-hidden rounded-xl border border-line transition group-hover:border-sage">
              <img src={e.result} alt={`Try-on: ${e.garmentLabel}`} className="aspect-[3/4] w-full object-cover" />
            </span>
            <span className="mt-1 flex items-center gap-1">
              {e.verdict && (
                <span className={`font-tag text-[11px] ${COLOR[e.verdict.verdict]}`} aria-hidden>
                  {GLYPH[e.verdict.verdict]}
                </span>
              )}
              <span className="truncate text-[11px] text-ink-soft">{e.garmentLabel}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
