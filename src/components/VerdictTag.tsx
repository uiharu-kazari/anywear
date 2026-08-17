import { useStore } from '../lib/store';

const VERDICT_META = {
  wear_it: { label: 'Wear it', glyph: '✓', color: 'text-sage-deep', ring: 'ring-sage/50' },
  maybe: { label: 'Maybe', glyph: '≈', color: 'text-ochre', ring: 'ring-ochre/40' },
  skip: { label: 'Skip it', glyph: '✕', color: 'text-brick', ring: 'ring-brick/40' },
} as const;

export default function VerdictTag() {
  const { stage, verdict, verdictStatus, occasion, skin, requestVerdict } = useStore();

  if (stage.phase !== 'done' && verdictStatus === 'idle') {
    return (
      <div className="rounded-2xl border border-dashed border-line p-5 text-center">
        <p className="tag-label mb-2">stylist verdict</p>
        <p className="text-xs leading-relaxed text-ink-soft">
          Finish a try-on and your stylist will judge the look for{' '}
          <span className="text-ink italic">{occasion}</span>
          {skin.brief ? ' — against today’s skin brief.' : '.'}
        </p>
      </div>
    );
  }

  if (verdictStatus === 'running') {
    return (
      <div className="scanline relative overflow-hidden rounded-2xl border border-line bg-paper p-5">
        <p className="tag-label mb-2">stylist verdict</p>
        <p className="text-xs text-ink-soft">Looking you over…</p>
        <div className="mt-3 space-y-2">
          <div className="h-3 w-3/4 rounded bg-line/70" />
          <div className="h-3 w-full rounded bg-line/50" />
          <div className="h-3 w-2/3 rounded bg-line/50" />
        </div>
      </div>
    );
  }

  if (verdictStatus === 'error') {
    return (
      <div className="rounded-2xl border border-line bg-paper p-5">
        <p className="tag-label mb-2">stylist verdict</p>
        <p className="text-xs text-ink-soft">
          The stylist stepped away.{' '}
          <button type="button" onClick={requestVerdict} className="text-ink underline underline-offset-2">
            Ask again
          </button>
        </p>
      </div>
    );
  }

  if (!verdict) return null;
  const meta = VERDICT_META[verdict.verdict];

  return (
    <div className="tag-swing relative origin-top" aria-live="polite">
      {/* string + punched hole */}
      <div className="absolute -top-1 left-1/2 h-5 w-px -translate-x-1/2 bg-ink/30" aria-hidden />
      <div className="relative rounded-2xl border border-line bg-paper p-5 shadow-[0_10px_30px_rgba(34,31,28,0.10)]">
        <div className="absolute top-2.5 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-ink/20 bg-porcelain" aria-hidden />
        <p className="tag-label mt-2 mb-3 text-center">stylist verdict · {occasion}</p>
        <p className={`text-center font-display text-4xl font-medium ${meta.color}`}>
          <span aria-hidden>{meta.glyph}</span> {meta.label}
        </p>
        <p className="mt-1 text-center font-tag text-[11px] text-ink-soft">{verdict.score}/100</p>
        <p className="mt-3 text-center font-display text-lg leading-snug italic">“{verdict.headline}”</p>
        <ul className="mt-4 space-y-1.5 border-t border-dashed border-line pt-3">
          {verdict.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-soft">
              <span className="text-ink/40" aria-hidden>
                —
              </span>
              {r}
            </li>
          ))}
        </ul>
        <p className="mt-3 rounded-lg bg-blush-tint/60 p-2.5 text-xs leading-relaxed text-blush-deep">
          {verdict.skin_harmony}
        </p>
        {verdict.pairing.length > 0 && (
          <>
            <p className="tag-label mt-3 mb-1.5">complete it</p>
            <div className="flex flex-wrap gap-1.5">
              {verdict.pairing.map((p, i) => (
                <span key={i} className="rounded-full border border-line px-2.5 py-1 text-[11px]">
                  {p}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
