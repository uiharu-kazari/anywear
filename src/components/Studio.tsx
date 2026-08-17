import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { fileToDataURL } from '../lib/image';
import TwinPanel from './TwinPanel';
import SkinPanel from './SkinPanel';
import MirrorStage from './MirrorStage';
import VerdictTag from './VerdictTag';
import Lookbook from './Lookbook';

const OCCASIONS = ['a regular day out', 'the office', 'a first date', 'a job interview', 'a wedding guest look', 'a night out'];

export default function Studio() {
  const { occasion, setOccasion, submitScreenshot, resetAll, stage, verdictStatus, requestVerdict } = useStore();
  const [units, setUnits] = useState<number | null>(null);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    api.credits().then((r) => setUnits(r.units)).catch(() => {});
  }, [stage.phase]);

  // Paste a screenshot anywhere in the studio.
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) submitScreenshot(await fileToDataURL(file));
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [submitScreenshot]);

  return (
    <div
      className="min-h-dvh"
      style={{ background: 'radial-gradient(120% 90% at 50% -10%, #fbfaf7 0%, #f6f4f1 55%, #efece7 100%)' }}
    >
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 pt-5 pb-2">
        <p className="font-display text-2xl font-medium">
          Any<span className="italic text-sage-deep">wear</span>
        </p>
        <div className="flex items-center gap-4">
          {units !== null && <span className="tag-label">{units} youcam units</span>}
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Clear your photos, skin reading and lookbook?')) resetAll();
            }}
            className="text-xs text-ink-soft underline-offset-2 hover:underline"
          >
            Start fresh
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 overflow-x-clip px-5 pb-8 lg:grid-cols-[270px_minmax(0,1fr)_320px]">
        <div className="order-2 flex flex-col gap-4 lg:order-1">
          <TwinPanel />
          <SkinPanel />
        </div>

        <div className="order-1 lg:order-2">
          <MirrorStage />
        </div>

        <div className="order-3 flex flex-col gap-4">
          <section className="rounded-2xl border border-line bg-paper p-4">
            <h2 className="tag-label mb-3">Dressing for</h2>
            <div className="flex flex-wrap gap-1.5">
              {OCCASIONS.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => {
                    setOccasion(o);
                    if (stage.phase === 'done' && verdictStatus !== 'running') void requestVerdict();
                  }}
                  aria-pressed={occasion === o}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    occasion === o
                      ? 'border-sage-deep bg-sage-deep text-white'
                      : 'border-line hover:border-ink/40'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
            <form
              className="mt-2 flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.trim()) {
                  setOccasion(custom.trim());
                  if (stage.phase === 'done' && verdictStatus !== 'running') void requestVerdict();
                }
              }}
            >
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="or type your own…"
                className="min-w-0 flex-1 rounded-full border border-line bg-transparent px-3 py-1.5 text-xs outline-none focus:border-sage-deep"
              />
              <button type="submit" className="rounded-full border border-line px-3 py-1.5 text-xs hover:border-ink/40">
                Set
              </button>
            </form>
          </section>

          <VerdictTag />
        </div>
      </main>

      <div className="mx-auto max-w-7xl px-5 pb-10">
        <Lookbook />
      </div>

      <footer className="mx-auto max-w-7xl px-5 pb-6">
        <p className="tag-label">
          youcam skin ai + apparel vto · gemini styling brain · not medical advice
        </p>
      </footer>
    </div>
  );
}
