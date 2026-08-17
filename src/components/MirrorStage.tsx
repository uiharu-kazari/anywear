import { useState } from 'react';
import { useStore } from '../lib/store';
import { fileToDataURL, urlToDataURL } from '../lib/image';
import BeforeAfter from './BeforeAfter';

const SAMPLES = [
  { src: '/samples/street_model.png', label: 'Street-style photo' },
  { src: '/samples/garment_dress.png', label: 'Slip dress shot' },
  { src: '/samples/garment_jacket.png', label: 'Blazer product shot' },
];

export default function MirrorStage() {
  const { stage, twinPhoto, submitScreenshot, pickGarment, clearStage } = useStore();
  const [dragOver, setDragOver] = useState(false);

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (file && file.type.startsWith('image/')) submitScreenshot(await fileToDataURL(file));
  }

  return (
    <div
      className={`relative flex h-full min-h-[520px] flex-col overflow-hidden rounded-[26px] border bg-paper shadow-[inset_0_0_60px_rgba(34,31,28,0.05)] transition ${
        dragOver ? 'border-sage ring-2 ring-sage/40' : 'border-line'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      {stage.phase === 'empty' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
          <p className="font-display text-4xl font-medium">
            Drop any <span className="italic text-sage-deep">screenshot</span>
          </p>
          <p className="max-w-sm text-sm leading-relaxed text-ink-soft">
            A shop page, a social post, a street photo — Anywear finds the clothes in it. Or paste one straight from
            your clipboard (⌘V).
          </p>
          <label className="cursor-pointer rounded-full border border-ink/25 px-6 py-3 text-sm font-medium transition hover:border-ink">
            Choose an image
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <div className="mt-4">
            <p className="tag-label mb-3">or try one of these</p>
            <div className="flex justify-center gap-3">
              {SAMPLES.map((s) => (
                <button
                  key={s.src}
                  type="button"
                  onClick={async () => submitScreenshot(await urlToDataURL(s.src))}
                  className="group w-24 overflow-hidden rounded-xl border border-line transition hover:border-sage"
                  title={s.label}
                >
                  <img
                    src={s.src}
                    alt={s.label}
                    className="aspect-[3/4] w-full object-cover transition group-hover:scale-105"
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {stage.phase === 'detecting' && (
        <div className="scanline relative flex-1">
          <img src={stage.screenshot} alt="Your screenshot" className="h-full w-full object-contain opacity-80" />
          <p className="tag-label absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-paper/90 px-4 py-2">
            reading the look…
          </p>
        </div>
      )}

      {stage.phase === 'pick' && (
        <div className="flex flex-1 flex-col">
          <div className="relative flex-1">
            <div className="absolute inset-0 flex items-center justify-center p-3">
              <div className="relative max-h-full max-w-full">
                <img src={stage.screenshot} alt="Your screenshot" className="max-h-[56vh] w-auto rounded-lg" />
                {stage.garments.map((g, i) => {
                  const [ymin, xmin, ymax, xmax] = g.box_2d;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => pickGarment(g)}
                      className="group absolute rounded-md border-2 border-white/80 bg-sage/0 outline-2 outline-sage-deep/0 transition hover:bg-sage/15 hover:outline-sage-deep focus-visible:outline-sage-deep"
                      style={{
                        top: `${ymin / 10}%`,
                        left: `${xmin / 10}%`,
                        width: `${(xmax - xmin) / 10}%`,
                        height: `${(ymax - ymin) / 10}%`,
                      }}
                    >
                      <span className="tag-label absolute -top-2 left-1 -translate-y-full rounded bg-ink px-1.5 py-0.5 whitespace-nowrap !text-white opacity-90 group-hover:!bg-sage-deep">
                        {g.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="border-t border-line px-5 py-3 text-center">
            <p className="text-sm text-ink-soft">
              Found {stage.garments.length} pieces — tap the one you want on you.
            </p>
          </div>
        </div>
      )}

      {stage.phase === 'running' && twinPhoto && (
        <div className="scanline relative flex-1">
          <img src={twinPhoto} alt="You" className="h-full w-full object-cover opacity-90" />
          <div className="absolute right-4 bottom-4 w-20 overflow-hidden rounded-lg border-2 border-paper shadow-lg">
            <img src={stage.garment.crop} alt={stage.garment.label} className="aspect-[3/4] w-full object-cover" />
          </div>
          <p className="tag-label absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-paper/90 px-4 py-2">
            tailoring {stage.garment.label.toLowerCase()} onto you…
          </p>
        </div>
      )}

      {stage.phase === 'done' && twinPhoto && (
        <div className="flex flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <BeforeAfter before={twinPhoto} after={stage.result} altAfter={`You wearing ${stage.garment.label}`} />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src={stage.garment.crop} alt="" className="h-10 w-8 rounded object-cover" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{stage.garment.label}</p>
                <p className="tag-label">{stage.garment.category.replace('_', ' ')}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={clearStage}
              className="shrink-0 rounded-full border border-ink/25 px-4 py-2 text-xs font-medium transition hover:border-ink"
            >
              Try another
            </button>
          </div>
        </div>
      )}

      {stage.phase === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="font-display text-2xl">That one didn't work</p>
          <p className="max-w-sm text-sm leading-relaxed text-ink-soft">{stage.message}</p>
          <button
            type="button"
            onClick={clearStage}
            className="rounded-full bg-ink px-6 py-3 text-sm font-medium text-white transition hover:bg-sage-deep"
          >
            Start over
          </button>
        </div>
      )}
    </div>
  );
}
