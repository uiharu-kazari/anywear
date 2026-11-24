import { useState } from 'react';
import { SAMPLES as SAMPLE_DIR } from '../lib/samples';
import { useStore } from '../lib/store';
import { urlToDataURL } from '../lib/image';
import { UNREADABLE_FILE } from '../lib/store';
import BeforeAfter from './BeforeAfter';

const SAMPLES = [
  { src: SAMPLE_DIR + 'street_model.png', label: 'Street-style photo' },
  { src: SAMPLE_DIR + 'garment_dress.png', label: 'Slip dress shot' },
  { src: SAMPLE_DIR + 'garment_jacket.png', label: 'Blazer product shot' },
];

export default function MirrorStage() {
  const { stage, twinPhoto, submitScreenshot, pickGarment, clearStage, readImage, showNotice } = useStore();
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  // The pick screenshot's width/height, so it (and its boxes) can be scaled to
  // whatever room the garment list leaves.
  const [ratio, setRatio] = useState(1);
  // A saved look whose image can no longer be loaded (Anna image links expire).
  const [brokenResult, setBrokenResult] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    const dataUrl = await readImage(files?.[0]);
    if (dataUrl) submitScreenshot(dataUrl);
  }

  const cancel = (label: string) => (
    <button
      type="button"
      onClick={clearStage}
      className="absolute top-3 right-3 z-10 rounded-full bg-paper/90 px-3 py-1.5 text-xs font-medium shadow-sm transition hover:bg-paper"
    >
      {label}
    </button>
  );

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
            your clipboard (⌘V / Ctrl+V).
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
                  onClick={async () => {
                    try {
                      submitScreenshot(await urlToDataURL(s.src));
                    } catch {
                      showNotice(UNREADABLE_FILE);
                    }
                  }}
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
        <div className="scanline relative min-h-0 flex-1 overflow-hidden">
          <img src={stage.screenshot} alt="Your screenshot" className="absolute inset-0 h-full w-full object-contain opacity-80" />
          {cancel('Cancel')}
          <p className="tag-label absolute bottom-4 left-1/2 max-w-[70%] -translate-x-1/2 rounded-full bg-paper/90 px-4 py-2 text-center">
            reading the look…
          </p>
        </div>
      )}

      {stage.phase === 'pick' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 [container-type:size]">
            <div className="absolute inset-0 flex items-center justify-center">
              {/* Largest box of the screenshot's shape that fits the pane (12px margin). */}
              <div
                className="relative"
                style={{
                  width: `min(calc(100cqw - 24px), calc((100cqh - 24px) * ${ratio}))`,
                  aspectRatio: String(ratio),
                }}
              >
                <img
                  src={stage.screenshot}
                  alt="Your screenshot"
                  className="absolute inset-0 h-full w-full rounded-lg"
                  onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
                />
                {/* Biggest boxes first, so smaller pieces inside an outfit box
                    sit on top and stay clickable. Names are in the list below. */}
                {stage.garments
                  .map((g, i) => ({ g, i }))
                  .sort((a, b) => area(b.g.box_2d) - area(a.g.box_2d))
                  .map(({ g, i }) => {
                    const [ymin, xmin, ymax, xmax] = g.box_2d;
                    return (
                      <button
                        key={i}
                        type="button"
                        // Mouse shortcut only; the named buttons below serve keyboards
                        // and screen readers.
                        aria-hidden
                        tabIndex={-1}
                        title={g.label}
                        onClick={() => pickGarment(g)}
                        onMouseEnter={() => setHovered(i)}
                        onMouseLeave={() => setHovered(null)}
                        className={`absolute rounded-md border-2 transition focus-visible:outline-2 focus-visible:outline-sage-deep ${
                          hovered === i ? 'border-sage-deep bg-sage/20' : 'border-white/80 hover:bg-sage/15'
                        }`}
                        style={{
                          top: `${ymin / 10}%`,
                          left: `${xmin / 10}%`,
                          width: `${(xmax - xmin) / 10}%`,
                          height: `${(ymax - ymin) / 10}%`,
                        }}
                      />
                    );
                  })}
              </div>
            </div>
          </div>
          <div className="border-t border-line px-5 py-3 text-center">
            <p className="text-sm text-ink-soft">Found {stage.garments.length} pieces — pick the one you want on you:</p>
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              {stage.garments.map((g, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => pickGarment(g)}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(i)}
                  onBlur={() => setHovered(null)}
                  className="rounded-full border border-ink/25 px-3 py-1.5 text-xs font-medium transition hover:border-sage-deep hover:bg-sage-deep hover:text-white"
                >
                  {g.label}
                </button>
              ))}
              <button
                type="button"
                onClick={clearStage}
                className="rounded-full px-3 py-1.5 text-xs text-ink-soft underline-offset-2 hover:underline"
              >
                Choose another screenshot
              </button>
            </div>
          </div>
        </div>
      )}

      {stage.phase === 'running' && twinPhoto && (
        <div className="scanline relative min-h-0 flex-1 overflow-hidden">
          <img src={twinPhoto} alt="You" className="absolute inset-0 h-full w-full object-contain opacity-90" />
          {cancel('Cancel')}
          <div className="absolute right-4 bottom-4 w-20 overflow-hidden rounded-lg border-2 border-paper shadow-lg">
            <img src={stage.garment.crop} alt={stage.garment.label} className="aspect-[3/4] w-full object-cover" />
          </div>
          <p className="tag-label absolute bottom-4 left-1/2 max-w-[70%] -translate-x-1/2 rounded-full bg-paper/90 px-4 py-2 text-center">
            tailoring {stage.garment.label.toLowerCase()} onto you…
          </p>
        </div>
      )}

      {stage.phase === 'done' && twinPhoto && (
        <div className="flex flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {stage.result === brokenResult ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="font-display text-2xl">This look's image has expired</p>
                <p className="max-w-sm text-sm text-ink-soft">Try the garment on again to see it.</p>
              </div>
            ) : stage.sameTwin ? (
              <BeforeAfter
                before={twinPhoto}
                after={stage.result}
                altAfter={`You wearing ${stage.garment.label}`}
                onAfterError={() => setBrokenResult(stage.result)}
              />
            ) : (
              // Made from an earlier full-body photo: comparing it with the
              // current photo would put two different bodies side by side.
              <>
                <img
                  src={stage.result}
                  alt={`You wearing ${stage.garment.label}`}
                  className="absolute inset-0 h-full w-full object-contain"
                  onError={() => setBrokenResult(stage.result)}
                />
                <span className="tag-label absolute top-3 left-3 rounded-full bg-ink/55 px-2.5 py-1 !text-white/90">
                  from an earlier photo
                </span>
              </>
            )}
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

function area([ymin, xmin, ymax, xmax]: [number, number, number, number]): number {
  return (ymax - ymin) * (xmax - xmin);
}
