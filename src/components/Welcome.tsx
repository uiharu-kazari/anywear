import { useState } from 'react';
import { useStore } from '../lib/store';
import { urlToDataURL } from '../lib/image';
import PhotoSlot from './PhotoSlot';

export default function Welcome() {
  const { setTwin, setSelfie } = useStore();
  const [mode, setMode] = useState<'hero' | 'setup'>('hero');
  const [twinDraft, setTwinDraft] = useState<string | null>(null);
  const [selfieDraft, setSelfieDraft] = useState<string | null>(null);
  const [loadingDemo, setLoadingDemo] = useState(false);

  async function startDemo() {
    setLoadingDemo(true);
    try {
      const [person, selfie] = await Promise.all([
        urlToDataURL('/samples/person.png'),
        urlToDataURL('/samples/selfie.png'),
      ]);
      setSelfie(selfie);
      await setTwin(person); // setting the twin last flips App into the studio
    } finally {
      setLoadingDemo(false);
    }
  }

  async function finishSetup() {
    if (!twinDraft) return;
    if (selfieDraft) setSelfie(selfieDraft);
    await setTwin(twinDraft);
  }

  return (
    <main className="flex min-h-dvh flex-col bg-porcelain lg:flex-row">
      {/* Copy column */}
      <section className="flex flex-1 flex-col justify-center px-8 py-16 sm:px-14 lg:px-20">
        <p className="tag-label mb-6">Your fitting room, everywhere</p>
        <h1 className="font-display text-[17vw] leading-[0.9] font-medium tracking-tight sm:text-8xl lg:text-[7.5rem]">
          Any<span className="italic text-sage-deep">wear</span>
        </h1>
        <p className="mt-8 max-w-md text-lg font-light text-ink-soft">
          Screenshot any look, anywhere — see it on your own body in seconds, judged honestly for your skin, your
          colors, and your day.
        </p>

        {mode === 'hero' ? (
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={startDemo}
              disabled={loadingDemo}
              className="rounded-full bg-sage-deep px-7 py-3.5 text-sm font-medium text-white transition hover:bg-ink disabled:opacity-60"
            >
              {loadingDemo ? 'Setting up…' : 'Step in with the demo persona'}
            </button>
            <button
              type="button"
              onClick={() => setMode('setup')}
              className="rounded-full border border-ink/25 px-7 py-3.5 text-sm font-medium transition hover:border-ink"
            >
              Use my own photos
            </button>
          </div>
        ) : (
          <div className="mt-10 max-w-md">
            <div className="grid grid-cols-2 gap-4">
              <PhotoSlot
                tall
                label="Full-body photo · required"
                hint="Front-facing, standing, whole body in frame"
                photo={twinDraft}
                onPhoto={setTwinDraft}
              />
              <PhotoSlot
                tall
                label="Selfie · for skin analysis"
                hint="Close up, bare face, even light"
                photo={selfieDraft}
                onPhoto={setSelfieDraft}
              />
            </div>
            <div className="mt-6 flex items-center gap-4">
              <button
                type="button"
                onClick={finishSetup}
                disabled={!twinDraft}
                className="rounded-full bg-sage-deep px-7 py-3.5 text-sm font-medium text-white transition hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                Enter the fitting room
              </button>
              <button type="button" onClick={() => setMode('hero')} className="text-sm text-ink-soft hover:text-ink">
                Back
              </button>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ink-soft">
              Photos are sent only to Perfect Corp's YouCam AI for analysis and try-on, and kept on this device.
            </p>
          </div>
        )}

        <p className="tag-label mt-16">Powered by YouCam Skin AI · Apparel VTO · Gemini</p>
      </section>

      {/* Full-height image plane */}
      <section className="relative min-h-[46vh] flex-1 lg:min-h-dvh">
        <img
          src="/samples/hero_result.jpg"
          alt="A virtual try-on result: the demo persona wearing a sage satin slip dress"
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
        <div className="absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-ink/45 to-transparent px-6 pt-16 pb-4">
          <p className="tag-label !text-white/80">A real Anywear try-on · sage slip dress, from a screenshot</p>
        </div>
      </section>
    </main>
  );
}
