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
import { base64Of, cropByBox, fileToDataURL, imageSize, resizeDataURL, shrinkForStorage, urlToDataURL } from './image';

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
  // entryId: the lookbook entry this look is saved as; every verdict for it updates that entry.
  | { phase: 'done'; garment: GarmentPick; result: string; resultUrl: string; entryId: string }
  | { phase: 'error'; message: string; screenshot?: string };

export interface LookbookEntry {
  id: string;
  at: number;
  garmentLabel: string;
  // Missing on looks saved by v0.1.7 and earlier.
  garmentCategory?: DetectedGarment['category'];
  garmentDescription?: string;
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
  verdictOccasion: string | null; // the occasion the shown verdict was asked for
  lookbook: LookbookEntry[];
  notice: string | null; // a short message for the user (e.g. an unreadable file)

  setTwin: (dataUrl: string) => Promise<void>;
  setSelfie: (dataUrl: string) => void;
  showNotice: (message: string | null) => void;
  readImage: (file: File | undefined | null) => Promise<string | null>;
  runSkinAnalysis: () => Promise<void>;
  writeBrief: () => Promise<void>;
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
// Each screenshot -> try-on run is one "stage op". A new screenshot, Cancel, a
// new twin or opening a saved look starts a new op, and the old op stops.
let stageOp = 0;
// Each skin read / brief is one "skin op"; a new selfie or a newer read stops older ones.
let skinOp = 0;
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

/** Like sessionScope, but also stops once a newer stage op has started. */
function stageScope() {
  const mySession = session;
  const myOp = stageOp;
  const current = () => mySession === session && myOp === stageOp;
  return <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => (current() ? v : STOPPED),
      (err) => (current() ? Promise.reject(err) : STOPPED),
    );
}

/** Like sessionScope, but also stops once a newer skin op has started. */
function skinScope() {
  const mySession = session;
  const myOp = skinOp;
  const current = () => mySession === session && myOp === skinOp;
  return <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => (current() ? v : STOPPED),
      (err) => (current() ? Promise.reject(err) : STOPPED),
    );
}

export const UNREADABLE_FILE =
  "That file couldn't be opened as a photo. Please use a JPG, PNG or WebP image (iPhone HEIC photos: export them as JPG first).";

// Lookbook images for a look, re-encoded once even when several verdicts for
// it are in flight; they share one promise, so they resume (and save) in the
// order they were asked.
const encoding = new Map<string, Promise<[string, string]>>();
function encodeLook(id: string, crop: string, result: string): Promise<[string, string]> {
  let p = encoding.get(id);
  if (!p) {
    p = Promise.all([shrinkForStorage(crop, 260, 0.8), shrinkForStorage(result, 700, 0.82)]);
    encoding.set(id, p);
    void p.finally(() => encoding.delete(id));
  }
  return p;
}

const NEW_ID = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      verdictOccasion: null,
      lookbook: [],
      notice: null,

      setTwin: async (dataUrl) => {
        const live = sessionScope();
        const stored = await live(resizeDataURL(dataUrl, 1100, 0.86));
        // Replacing the twin invalidates any result generated for the old body,
        // including a try-on still running for it.
        stageOp++;
        set((s) => ({
          verdictSeq: s.verdictSeq + 1,
          twinPhoto: stored,
          twinFileId: null,
          stage: { phase: 'empty' },
          verdict: null,
          verdictStatus: 'idle',
        }));
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
        skinOp++; // a read or brief still running for the old selfie is dropped
        set({ selfiePhoto: dataUrl, skin: initialSkin });
      },

      showNotice: (message) => set({ notice: message }),

      readImage: async (file) => {
        if (!file) return null;
        try {
          if (file.type && !file.type.startsWith('image/')) throw new Error('not an image');
          const dataUrl = await fileToDataURL(file);
          set({ notice: null });
          return dataUrl;
        } catch {
          set({ notice: UNREADABLE_FILE });
          return null;
        }
      },

      runSkinAnalysis: async () => {
        // Only reachable from buttons shown once a selfie is set.
        const selfiePhoto = get().selfiePhoto!;
        skinOp++;
        const live = skinScope();
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
          set({ skin: { status: 'done', output, brief: null, briefStatus: 'idle' } });
        } catch (err) {
          set({ skin: { ...initialSkin, status: 'error', error: friendlyAnnaError(err) || 'Failed.' } });
          return;
        }
        await get().writeBrief();
      },

      writeBrief: async () => {
        skinOp++;
        const live = skinScope();
        const { output } = get().skin;
        set((s) => ({ skin: { ...s.skin, brief: null, briefStatus: 'running' } }));
        const concerns = output
          .filter((o) => typeof o.ui_score === 'number' && o.type !== 'all')
          .map((o) => ({ type: o.type, raw_score: o.raw_score ?? 0, ui_score: o.ui_score as number }));
        try {
          const { brief } = await live(api.skinBrief(concerns));
          set((s) => ({ skin: { ...s.skin, brief, briefStatus: 'done' } }));
        } catch {
          set((s) => ({ skin: { ...s.skin, briefStatus: 'error' } }));
        }
      },

      setOccasion: (occasion) => set({ occasion }),

      submitScreenshot: async (dataUrl) => {
        // A screenshot that finished loading after "Start fresh" has no twin
        // to try on; don't detect (and bill) anything for it.
        if (!get().twinPhoto) return;
        stageOp++;
        const live = stageScope();
        set((s) => ({
          stage: { phase: 'detecting', screenshot: dataUrl },
          verdict: null,
          verdictStatus: 'idle',
          verdictSeq: s.verdictSeq + 1,
        }));
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
        const live = stageScope();
        let crop: string;
        try {
          crop = await live(cropByBox(st.screenshot, garment.box_2d));
        } catch {
          set({ stage: { phase: 'error', message: 'Could not cut that piece out of the screenshot — try another one.' } });
          return;
        }
        await get().tryGarment({ ...pick, crop });
      },

      tryGarment: async (garment) => {
        const live = stageScope();
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
            set({ stage: { phase: 'done', garment, result, resultUrl: url, entryId: NEW_ID() } });
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
          set({ stage: { phase: 'done', garment, result, resultUrl: st.url, entryId: NEW_ID() } });
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
        // Judge the look on stage: a fresh try-on, or a saved look reopened
        // from the lookbook (judged from its stored image). Callers only offer
        // judging while a look is on stage; this guards against misuse.
        /* istanbul ignore if -- @preserve */
        if (stage.phase !== 'done') return;
        const live = sessionScope();
        const seq = get().verdictSeq + 1;
        set({ verdictStatus: 'running', verdict: null, verdictSeq: seq, verdictOccasion: occasion });
        let verdict: StylistVerdict | null = null;
        try {
          ({ verdict } = await live(api.verdict({
            tryOnUrl: stage.resultUrl || stage.result,
            tryOnDataUrl: stage.result,
            garment: { label: stage.garment.label, description: stage.garment.description },
            occasion,
            brief: skin.brief,
          })));
          // A newer request (occasion change / new try-on) supersedes this one.
          if (get().verdictSeq !== seq) return;
          set({ verdict, verdictStatus: 'done' });
        } catch {
          if (get().verdictSeq !== seq) return;
          // Still keep the look in the book, just without a verdict.
          set({ verdictStatus: 'error' });
        }
        // Save the look under its entry id (fixed when the try-on finished), so
        // re-judging (another occasion, "Ask again", a reopened look) updates
        // that one entry instead of adding a duplicate.
        const id = stage.entryId;
        const savedEntry = () => get().lookbook.find((e) => e.id === id);
        // A failed re-judge keeps the verdict the look already had.
        if (!verdict && savedEntry()) return;
        const first = savedEntry();
        const [thumb, resultSmall] = first
          ? [first.garmentThumb, first.result]
          : await live(encodeLook(id, stage.garment.crop, stage.result));
        // An older verdict may have saved the look meanwhile; a failure still
        // never replaces a verdict it already has.
        if (!verdict && savedEntry()?.verdict) return;
        const entry: LookbookEntry = {
          id,
          at: Date.now(),
          garmentLabel: stage.garment.label,
          garmentCategory: stage.garment.category,
          garmentDescription: stage.garment.description,
          garmentThumb: thumb,
          result: resultSmall,
          occasion,
          verdict,
        };
        set((s) => ({ lookbook: [entry, ...s.lookbook.filter((e) => e.id !== id)].slice(0, 10) }));
      },

      openLookbookEntry: (entry) => {
        stageOp++;
        set((s) => ({
          stage: {
            phase: 'done',
            garment: {
              label: entry.garmentLabel,
              // Looks saved before v0.1.8 have no category/description.
              category: entry.garmentCategory ?? /* istanbul ignore next -- @preserve */ 'full_body',
              description: entry.garmentDescription ?? /* istanbul ignore next -- @preserve */ '',
              crop: entry.garmentThumb,
            },
            result: entry.result,
            resultUrl: '',
            entryId: entry.id,
          },
          verdict: entry.verdict,
          // A look saved without a verdict offers "Ask again".
          verdictStatus: entry.verdict ? 'done' : 'error',
          verdictOccasion: entry.occasion,
          verdictSeq: s.verdictSeq + 1,
        }));
      },

      clearStage: () => {
        stageOp++;
        set((s) => ({ stage: { phase: 'empty' }, verdict: null, verdictStatus: 'idle', verdictSeq: s.verdictSeq + 1 }));
      },

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
          notice: null,
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
        // A brief still being written when the window closed is not coming
        // back; save it as failed so the panel offers Retry after reopening.
        skin:
          s.skin.status !== 'done'
            ? initialSkin
            : s.skin.briefStatus === 'running'
              ? { ...s.skin, briefStatus: 'error' as const }
              : s.skin,
      }),
    },
  ),
);
