import { useEffect, useState } from 'react';
import { onHydrationError, useStore } from './lib/store';
import Welcome from './components/Welcome';
import Studio from './components/Studio';

export default function App() {
  const twinPhoto = useStore((s) => s.twinPhoto);
  // Anna storage hydrates asynchronously; don't flash the welcome screen (and
  // let a click overwrite a saved twin) before the saved state arrives.
  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated());
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (hydrated) return;
    const off = useStore.persist.onFinishHydration(() => setHydrated(true));
    const offErr = onHydrationError((err) => {
      console.warn('[anywear] could not load saved state', err);
      // An App window restored after an update still carries the old version's
      // token, which the host rejects ("token version mismatch").
      setLoadError(
        /version mismatch/i.test(String(err))
          ? 'Anywear was just updated.'
          : 'Anywear could not load your saved fitting room.',
      );
    });
    // Race guard: hydration finished between render and this effect.
    /* istanbul ignore next -- @preserve */
    if (useStore.persist.hasHydrated()) setHydrated(true);
    return () => {
      off();
      offErr();
    };
  }, [hydrated]);
  if (!hydrated) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-8 text-center">
        {loadError ? (
          <div className="max-w-sm space-y-3">
            <p className="font-display text-2xl">{loadError}</p>
            <p className="text-sm text-ink/70">Close this window and open Anywear again — your twin, skin read and lookbook are safe.</p>
          </div>
        ) : (
          <p className="tag-label animate-pulse">Opening your fitting room…</p>
        )}
      </div>
    );
  }
  return twinPhoto ? <Studio /> : <Welcome />;
}
