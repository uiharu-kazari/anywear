import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { IS_ANNA, friendlyAnnaError } from './anna';
import { appStorage } from './persist';
import {
  annaApi,
  api,
  pollUntilDone,
  proxied,
  type DetectedGarment,
  type SkinBrief,
  type SkinOutput,
  type StylistVerdict,
} from './api';
import { base64Of, cropByBox, imageSize, resizeDataURL, shrinkForStorage, urlToDataURL } from './image';

export interface GarmentPick {
  label: string;
  category: DetectedGarment['category'];
  description: string;
  crop: string; // dataURL of the cropped reference image
}

export type StagePhase =
  | { phase: 'empty' }
  | { phase: 'detecting'; screenshot: string }
  | { phase: 'pick'; screenshot: string; garments: DetectedGarment[] }
  | { phase: 'running'; garment: GarmentPick }
  | { phase: 'done'; garment: GarmentPick; result: string; resultUrl: string }
  | { phase: 'error'; message: string; screenshot?: string };

export interface LookbookEntry {
  id: string;
  at: number;
  garmentLabel: string;
  garmentThumb: string;
  result: string;
  occasion: string;
  verdict: StylistVerdict | null;
}

interface SkinState {
  status: 'idle' | 'running' | 'done' | 'error';
  error?: string;
  output: SkinOutput[];
  brief: SkinBrief | null;
  briefStatus: 'idle' | 'running' | 'done' | 'error';
}

interface AnywearState {
  twinPhoto: string | null; // stored downscaled dataURL
  twinFileId: string | null; // web: YouCam file_id (~30 days) · Anna: durable upload r2_key
  selfiePhoto: string | null;
  skin: SkinState;
  occasion: string;
  stage: StagePhase;
  verdict: StylistVerdict | null;
  verdictStatus: 'idle' | 'running' | 'done' | 'error';
  verdictSeq: number; // monotonic; a returning verdict applies only if it is latest
  lookbook: LookbookEntry[];
  busyError: string | null;

  setTwin: (dataUrl: string) => Promise<void>;
  setSelfie: (dataUrl: string) => void;
  runSkinAnalysis: () => Promise<void>;
  setOccasion: (occasion: string) => void;
  submitScreenshot: (dataUrl: string) => Promise<void>;
  pickGarment: (garment: DetectedGarment) => Promise<void>;
  tryGarment: (garment: GarmentPick) => Promise<void>;
  requestVerdict: () => Promise<void>;
  openLookbookEntry: (entry: LookbookEntry) => void;
  clearStage: () => void;
  resetAll: () => void;
}

const initialSkin: SkinState = { status: 'idle', output: [], brief: null, briefStatus: 'idle' };

// "Start fresh" begins a new session. Work started in an older session (a
// try-on, skin read, verdict…) must not write its results into the new one.
let session = 0;
const STOPPED = new Promise<never>(() => {});

/** Called when an action starts; wrap each of its awaits in the returned
 * function. Once the user starts fresh, the action stops at its next await
 * (that promise never settles) instead of writing stale results back. */
function sessionScope() {
  const mine = session;
  return <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => (mine === session ? v : STOPPED),
      (err) => (mine === session ? Promise.reject(err) : STOPPED),
    );
}

let hydrationError: unknown = null;
const hydrationErrorListeners = new Set<(err: unknown) => void>();

/** Fires (immediately, if it already happened) when loading saved state fails. */
export function onHydrationError(cb: (err: unknown) => void): () => void {
  // Race guard: loading failed before the App subscribed.
  /* istanbul ignore next -- @preserve */
  if (hydrationError) cb(hydrationError);
  hydrationErrorListeners.add(cb);
  return () => hydrationErrorListeners.delete(cb);
}

export const useStore = create<AnywearState>()(
  persist(
    (set, get) => ({
      twinPhoto: null,
      twinFileId: null,
      selfiePhoto: null,
      skin: initialSkin,
      occasion: 'a regular day out',
      stage: { phase: 'empty' },
      verdict: null,
      verdictStatus: 'idle',
      verdictSeq: 0,
      lookbook: [],
      busyError: null,

      setTwin: async (dataUrl) => {
        const live = sessionScope();
        const stored = await live(resizeDataURL(dataUrl, 1100, 0.86));
        // Replacing the twin invalidates any result generated for the old body.
        set({
          twinPhoto: stored,
          twinFileId: null,
          stage: { phase: 'empty' },
          verdict: null,
          verdictStatus: 'idle',
        });
        try {
          const fileId = IS_ANNA
            ? await live(annaApi.uploadTwin(stored))
            : (await live(api.uploadPhoto(base64Of(dataUrl), 'image/jpeg', 'twin.jpg'))).fileId;
          // Only keep this fileId if the twin hasn't been replaced again meanwhile.
          if (get().twinPhoto === stored) set({ twinFileId: fileId });
        } catch {
          // Upload retried lazily on the first try-on.
        }
      },

      setSelfie: (dataUrl) => {
        set({ selfiePhoto: dataUrl, skin: initialSkin });
      },

      runSkinAnalysis: async () => {
        // Only reachable from buttons shown once a selfie is set.
        const selfiePhoto = get().selfiePhoto!;
        const live = sessionScope();
        set({ skin: { ...initialSkin, status: 'running' } });
        try {
          let output: SkinOutput[];
          if (IS_ANNA) {
            output = await live(annaApi.skinRead(selfiePhoto));
          } else {
            const { taskId } = await live(api.skinStart(base64Of(selfiePhoto), 'image/jpeg'));
            const st = await live(pollUntilDone(() => api.skinStatus(taskId), { intervalMs: 2500 }));
            if (st.status !== 'success') throw new Error(st.error ?? 'Skin analysis failed.');
            output = st.output ?? [];
          }
          set({ skin: { status: 'done', output, brief: null, briefStatus: 'running' } });
          const concerns = output
            .filter((o) => typeof o.ui_score === 'number' && o.type !== 'all')
            .map((o) => ({ type: o.type, raw_score: o.raw_score ?? 0, ui_score: o.ui_score as number }));
          try {
            const { brief } = await live(api.skinBrief(concerns));
            set((s) => ({ skin: { ...s.skin, brief, briefStatus: 'done' } }));
          } catch {
            set((s) => ({ skin: { ...s.skin, briefStatus: 'error' } }));
          }
        } catch (err) {
          set({ skin: { ...initialSkin, status: 'error', error: friendlyAnnaError(err) || 'Failed.' } });
        }
      },

      setOccasion: (occasion) => set({ occasion }),

      submitScreenshot: async (dataUrl) => {
        const live = sessionScope();
        set({ stage: { phase: 'detecting', screenshot: dataUrl }, verdict: null, verdictStatus: 'idle' });
        try {
          const { garments } = await live(api.detectGarments(base64Of(dataUrl), 'image/jpeg'));
          if (!garments.length) {
            set({
              stage: {
                phase: 'error',
                message: 'No wearable garment found in that image — try a screenshot where the clothing is clearly visible.',
                screenshot: dataUrl,
              },
            });
            return;
          }
          if (garments.length === 1) {
            const crop = await live(cropByBox(dataUrl, garments[0].box_2d));
            await get().tryGarment({
              label: garments[0].label,
              category: garments[0].category,
              description: garments[0].description,
              crop,
            });
            return;
          }
          set({ stage: { phase: 'pick', screenshot: dataUrl, garments } });
        } catch (err) {
          set({
            stage: { phase: 'error', message: friendlyAnnaError(err) || 'Detection failed.', screenshot: dataUrl },
          });
        }
      },

      pickGarment: async (garment) => {
        const st = get().stage;
        if (st.phase !== 'pick') return;
        // Flip out of 'pick' synchronously so a double-tap can't launch two
        // paid try-on tasks while cropByBox is still running.
        const pick: GarmentPick = {
          label: garment.label,
          category: garment.category,
          description: garment.description,
          crop: st.screenshot,
        };
        set({ stage: { phase: 'running', garment: pick } });
        const live = sessionScope();
        const crop = await live(cropByBox(st.screenshot, garment.box_2d));
        await get().tryGarment({ ...pick, crop });
      },

      tryGarment: async (garment) => {
        const live = sessionScope();
        set({ stage: { phase: 'running', garment }, verdict: null, verdictStatus: 'idle' });
        if (IS_ANNA) {
          try {
            // Try-ons start from the studio, which only exists with a twin, and
            // work from an older session stops at its next await (sessionScope).
            const twinPhoto = get().twinPhoto!;
            const { width, height } = await live(imageSize(twinPhoto));
            // Always a full-length portrait frame (a square or landscape output
            // made the model zoom in on the torso). For portrait twins, match the
            // photo's own ratio so before/after line up.
            const ratios: [string, number][] = [['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4]];
            const r = width / height;
            const [aspectRatio, best] = ratios.reduce((a, b) => (Math.abs(Math.log(b[1] / r)) < Math.abs(Math.log(a[1] / r)) ? b : a));
            const size = `${Math.round((1024 * best) / 16) * 16}x1024`;
            const { url, twinKey } = await live(annaApi.tryOn({ twinKey: get().twinFileId, twinPhoto, garment, size, aspectRatio }));
            if (get().twinPhoto === twinPhoto) set({ twinFileId: twinKey });
            // Anna result URLs expire in ~30 min; keep the pixels when the host
            // lets us read them, otherwise show the URL for this session.
            const result = await live(urlToDataURL(url, 1400).catch(() => url));
            set({ stage: { phase: 'done', garment, result, resultUrl: url } });
            void get().requestVerdict();
          } catch (err) {
            set({ stage: { phase: 'error', message: friendlyAnnaError(err) || 'Try-on failed.' } });
          }
          return;
        }
        try {
          let fileId = get().twinFileId;
          if (!fileId) {
            const photo = get().twinPhoto!; // see the Anna branch above
            fileId = (await live(api.uploadPhoto(base64Of(photo), 'image/jpeg', 'twin.jpg'))).fileId;
            set({ twinFileId: fileId });
          }
          const { taskId } = await live(api.vtoStart(fileId, base64Of(garment.crop), 'image/jpeg', garment.category));
          const st = await live(pollUntilDone(() => api.vtoStatus(taskId), { intervalMs: 3000 }));
          if (st.status !== 'success' || !st.url) throw new Error(st.error ?? 'Try-on failed.');
          const result = await live(urlToDataURL(proxied(st.url), 1400));
          set({ stage: { phase: 'done', garment, result, resultUrl: st.url } });
          void get().requestVerdict();
        } catch (err) {
          // A failed try-on may mean the stored twin file expired; drop it so
          // the next attempt re-uploads the photo instead of failing forever.
          set({
            twinFileId: null,
            stage: { phase: 'error', message: friendlyAnnaError(err) || 'Try-on failed.' },
          });
        }
      },

      requestVerdict: async () => {
        const { stage, occasion, skin } = get();
        // Can only judge a freshly generated try-on (a reopened lookbook entry
        // has no live URL to re-judge against).
        if (stage.phase !== 'done' || !stage.resultUrl) return;
        const live = sessionScope();
        const seq = get().verdictSeq + 1;
        set({ verdictStatus: 'running', verdict: null, verdictSeq: seq });
        try {
          const { verdict } = await live(api.verdict({
            tryOnUrl: stage.resultUrl,
            tryOnDataUrl: stage.result,
            garment: { label: stage.garment.label, description: stage.garment.description },
            occasion,
            brief: skin.brief,
          }));
          // A newer request (occasion change / new try-on) supersedes this one.
          if (get().verdictSeq !== seq) return;
          set({ verdict, verdictStatus: 'done' });
          const [thumb, resultSmall] = await live(
            Promise.all([shrinkForStorage(stage.garment.crop, 260, 0.8), shrinkForStorage(stage.result, 700, 0.82)]),
          );
          const entry: LookbookEntry = {
            id: `${Date.now()}`,
            at: Date.now(),
            garmentLabel: stage.garment.label,
            garmentThumb: thumb,
            result: resultSmall,
            occasion,
            verdict,
          };
          // Re-judging the same look (e.g. occasion change) updates its entry
          // instead of appending a duplicate.
          set((s) => ({
            lookbook: [entry, ...s.lookbook.filter((e) => e.result !== resultSmall)].slice(0, 10),
          }));
        } catch {
          if (get().verdictSeq !== seq) return;
          set({ verdictStatus: 'error' });
          // Still keep the look in the book, just without a verdict.
          const [thumb, resultSmall] = await live(
            Promise.all([shrinkForStorage(stage.garment.crop, 260, 0.8), shrinkForStorage(stage.result, 700, 0.82)]),
          );
          set((s) => ({
            lookbook: [
              {
                id: `${Date.now()}`,
                at: Date.now(),
                garmentLabel: stage.garment.label,
                garmentThumb: thumb,
                result: resultSmall,
                occasion,
                verdict: null,
              },
              ...s.lookbook,
            ].slice(0, 10),
          }));
        }
      },

      openLookbookEntry: (entry) => {
        set({
          stage: {
            phase: 'done',
            garment: { label: entry.garmentLabel, category: 'full_body', description: '', crop: entry.garmentThumb },
            result: entry.result,
            resultUrl: '',
          },
          verdict: entry.verdict,
          verdictStatus: entry.verdict ? 'done' : 'idle',
        });
      },

      clearStage: () =>
        set((s) => ({ stage: { phase: 'empty' }, verdict: null, verdictStatus: 'idle', verdictSeq: s.verdictSeq + 1 })),

      resetAll: () => {
        session++;
        set({
          twinPhoto: null,
          twinFileId: null,
          selfiePhoto: null,
          skin: initialSkin,
          stage: { phase: 'empty' },
          verdict: null,
          verdictStatus: 'idle',
          lookbook: [],
          busyError: null,
        });
      },
    }),
    {
      name: 'anywear',
      storage: createJSONStorage(appStorage),
      // zustand never marks the store hydrated when getItem throws; surface the
      // error so the UI can say so instead of loading forever.
      onRehydrateStorage: () => (_state, error) => {
        if (!error) return;
        hydrationError = error;
        hydrationErrorListeners.forEach((cb) => cb(error));
      },
      partialize: (s) => ({
        twinPhoto: s.twinPhoto,
        twinFileId: s.twinFileId,
        selfiePhoto: s.selfiePhoto,
        occasion: s.occasion,
        lookbook: s.lookbook,
        skin: s.skin.status === 'done' ? s.skin : initialSkin,
      }),
    },
  ),
);
