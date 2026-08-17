import { useState } from 'react';
import { useStore } from '../lib/store';
import { proxied } from '../lib/api';
import { fileToDataURL } from '../lib/image';

const CONCERN_NAMES: Record<string, string> = {
  redness: 'Redness',
  oiliness: 'Oil balance',
  moisture: 'Moisture',
  radiance: 'Radiance',
  acne: 'Clarity',
  texture: 'Texture',
  skin_type: 'Skin type',
};

export default function SkinPanel() {
  const { selfiePhoto, setSelfie, skin, runSkinAnalysis } = useStore();
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [maskLabel, setMaskLabel] = useState<string | null>(null);

  const scored = skin.output.filter((o) => typeof o.ui_score === 'number' && CONCERN_NAMES[o.type]);
  const skinType = skin.output.find((o) => o.skin_type)?.skin_type;
  const skinAge = skin.output.find((o) => o.type === 'skin_age')?.score;

  return (
    <section className="rounded-2xl border border-line bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="tag-label">Skin today</h2>
        {skin.status === 'done' && (
          <button type="button" onClick={runSkinAnalysis} className="text-xs text-ink-soft underline-offset-2 hover:underline">
            Re-read
          </button>
        )}
      </div>

      {!selfiePhoto && (
        <label className="block cursor-pointer rounded-xl border border-dashed border-line p-4 text-center text-xs leading-relaxed text-ink-soft transition hover:border-blush">
          Add a bare-faced selfie to read your skin and tune today's colors.
          <span className="mt-2 block font-medium text-blush-deep">Add selfie</span>
          <input
            type="file"
            accept="image/jpeg,image/png"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setSelfie(await fileToDataURL(f));
              e.target.value = '';
            }}
          />
        </label>
      )}

      {selfiePhoto && (
        <div className="flex gap-3">
          <div className={`relative w-20 shrink-0 overflow-hidden rounded-xl ${skin.status === 'running' ? 'scanline' : ''}`}>
            <img
              src={maskUrl ?? selfiePhoto}
              alt="Your selfie"
              className="aspect-[3/4] w-full object-cover"
              onError={() => setMaskUrl(null)}
            />
            {maskLabel && maskUrl && (
              <button
                type="button"
                className="tag-label absolute inset-x-0 bottom-0 bg-ink/60 py-0.5 text-center !text-white"
                onClick={() => {
                  setMaskUrl(null);
                  setMaskLabel(null);
                }}
              >
                {maskLabel} ✕
              </button>
            )}
          </div>

          <div className="min-w-0 flex-1">
            {skin.status === 'idle' && (
              <div className="flex h-full flex-col items-start justify-center gap-2">
                <p className="text-xs leading-relaxed text-ink-soft">
                  Seven concerns, scored by YouCam Skin AI in seconds.
                </p>
                <button
                  type="button"
                  onClick={runSkinAnalysis}
                  className="rounded-full bg-blush-deep px-4 py-2 text-xs font-medium text-white transition hover:bg-ink"
                >
                  Read my skin
                </button>
              </div>
            )}
            {skin.status === 'running' && <p className="text-xs text-ink-soft">Reading your skin…</p>}
            {skin.status === 'error' && (
              <div className="text-xs leading-relaxed text-brick">
                {skin.error}
                <button type="button" onClick={runSkinAnalysis} className="ml-2 underline">
                  Retry
                </button>
              </div>
            )}
            {skin.status === 'done' && (
              <ul className="space-y-1.5">
                {scored.map((o) => (
                  <li key={o.type}>
                    <button
                      type="button"
                      className="group w-full text-left"
                      title="Show detection areas"
                      onClick={() => {
                        if (o.mask_urls?.[0]) {
                          setMaskUrl(proxied(o.mask_urls[0]));
                          setMaskLabel(CONCERN_NAMES[o.type]);
                        }
                      }}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-xs group-hover:text-blush-deep">{CONCERN_NAMES[o.type]}</span>
                        <span className="font-tag text-[11px] text-ink-soft">{o.ui_score}</span>
                      </span>
                      <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-blush-tint">
                        <span className="block h-full rounded-full bg-blush" style={{ width: `${o.ui_score}%` }} />
                      </span>
                    </button>
                  </li>
                ))}
                {(skinType || skinAge) && (
                  <li className="pt-1 font-tag text-[11px] text-ink-soft">
                    {skinType && <>type · {skinType}</>}
                    {skinType && skinAge ? '  ·  ' : ''}
                    {skinAge && <>skin age · {Math.round(skinAge)}</>}
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Today's brief from Gemini */}
      {skin.status === 'done' && (
        <div className="mt-4 border-t border-line pt-3">
          {skin.briefStatus === 'running' && <p className="text-xs text-ink-soft">Writing today's brief…</p>}
          {skin.briefStatus === 'error' && <p className="text-xs text-ink-soft">Brief unavailable.</p>}
          {skin.brief && (
            <div>
              <p className="font-display text-lg leading-snug font-medium italic">“{skin.brief.headline}”</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{skin.brief.summary}</p>

              {skin.brief.care_focus.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {skin.brief.care_focus.map((c) => (
                    <li key={c.title} className="text-xs leading-relaxed">
                      <span className="font-medium">{c.title}.</span>{' '}
                      <span className="text-ink-soft">{c.action}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="tag-label mt-4 mb-2">today's palette</p>
              <div className="flex flex-wrap gap-1.5">
                {skin.brief.palette.wear.map((c) => (
                  <span key={c.hex} className="flex items-center gap-1.5 rounded-full border border-line py-1 pr-2.5 pl-1" title={c.why}>
                    <span className="h-4 w-4 rounded-full border border-ink/10" style={{ background: c.hex }} />
                    <span className="text-[11px]">{c.name}</span>
                  </span>
                ))}
                {skin.brief.palette.avoid.map((c) => (
                  <span
                    key={c.hex}
                    className="flex items-center gap-1.5 rounded-full border border-dashed border-line py-1 pr-2.5 pl-1 opacity-60"
                    title={`Avoid: ${c.why}`}
                  >
                    <span className="relative h-4 w-4 overflow-hidden rounded-full border border-ink/10" style={{ background: c.hex }}>
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] text-white">✕</span>
                    </span>
                    <span className="text-[11px] line-through decoration-ink/40">{c.name}</span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">{skin.brief.palette.guidance}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
