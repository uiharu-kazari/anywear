import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  api,
  pollUntilDone,
  proxied,
  type DetectedGarment,
  type SkinBrief,
  type SkinOutput,
  type StylistVerdict,
} from './api';
import { base64Of, cropByBox, resizeDataURL, urlToDataURL } from './image';

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
  twinFileId: string | null; // YouCam file_id (valid ~30 days)
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
  openLookbookEntry: (id: string) => void;
  clearStage: () => void;
  resetAll: () => void;
}

const initialSkin: SkinState = { status: 'idle', output: [], brief: null, briefStatus: 'idle' };

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
        const stored = await resizeDataURL(dataUrl, 1100, 0.86);
        // Replacing the twin invalidates any result generated for the old body.
        set({
          twinPhoto: stored,
          twinFileId: null,
          stage: { phase: 'empty' },
          verdict: null,
          verdictStatus: 'idle',
        });
        try {
          const { fileId } = await api.uploadPhoto(base64Of(dataUrl), 'image/jpeg', 'twin.jpg');
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
        const { selfiePhoto } = get();
        if (!selfiePhoto) return;
        set({ skin: { ...initialSkin, status: 'running' } });
        try {
          const { taskId } = await api.skinStart(base64Of(selfiePhoto), 'image/jpeg');
          const st = await pollUntilDone(() => api.skinStatus(taskId), { intervalMs: 2500 });
          if (st.status !== 'success') throw new Error(st.error ?? 'Skin analysis failed.');
          const output = st.output ?? [];
          set({ skin: { status: 'done', output, brief: null, briefStatus: 'running' } });
          const concerns = output
            .filter((o) => typeof o.ui_score === 'number' && o.type !== 'all')
            .map((o) => ({ type: o.type, raw_score: o.raw_score ?? 0, ui_score: o.ui_score ?? 0 }));
          try {
            const { brief } = await api.skinBrief(concerns);
            set((s) => ({ skin: { ...s.skin, brief, briefStatus: 'done' } }));
          } catch {
            set((s) => ({ skin: { ...s.skin, briefStatus: 'error' } }));
          }
        } catch (err) {
          set({ skin: { ...initialSkin, status: 'error', error: err instanceof Error ? err.message : 'Failed.' } });
        }
      },

      setOccasion: (occasion) => set({ occasion }),

      submitScreenshot: async (dataUrl) => {
        set({ stage: { phase: 'detecting', screenshot: dataUrl }, verdict: null, verdictStatus: 'idle' });
        try {
          const { garments } = await api.detectGarments(base64Of(dataUrl), 'image/jpeg');
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
            const crop = await cropByBox(dataUrl, garments[0].box_2d);
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
            stage: { phase: 'error', message: err instanceof Error ? err.message : 'Detection failed.', screenshot: dataUrl },
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
        const crop = await cropByBox(st.screenshot, garment.box_2d);
        await get().tryGarment({ ...pick, crop });
      },

      tryGarment: async (garment) => {
        set({ stage: { phase: 'running', garment }, verdict: null, verdictStatus: 'idle' });
        try {
          let fileId = get().twinFileId;
          if (!fileId) {
            const photo = get().twinPhoto;
            if (!photo) throw new Error('Add your photo first.');
            fileId = (await api.uploadPhoto(base64Of(photo), 'image/jpeg', 'twin.jpg')).fileId;
            set({ twinFileId: fileId });
          }
          const { taskId } = await api.vtoStart(fileId, base64Of(garment.crop), 'image/jpeg', garment.category);
          const st = await pollUntilDone(() => api.vtoStatus(taskId), { intervalMs: 3000 });
          if (st.status !== 'success' || !st.url) throw new Error(st.error ?? 'Try-on failed.');
          const result = await urlToDataURL(proxied(st.url), 1400);
          set({ stage: { phase: 'done', garment, result, resultUrl: st.url } });
          void get().requestVerdict();
        } catch (err) {
          // A failed try-on may mean the stored twin file expired; drop it so
          // the next attempt re-uploads the photo instead of failing forever.
          set({
            twinFileId: null,
            stage: { phase: 'error', message: err instanceof Error ? err.message : 'Try-on failed.' },
          });
        }
      },

      requestVerdict: async () => {
        const { stage, occasion, skin } = get();
        // Can only judge a freshly generated try-on (a reopened lookbook entry
        // has no live URL to re-judge against).
        if (stage.phase !== 'done' || !stage.resultUrl) return;
        const seq = get().verdictSeq + 1;
        set({ verdictStatus: 'running', verdict: null, verdictSeq: seq });
        try {
          const { verdict } = await api.verdict({
            tryOnUrl: stage.resultUrl,
            garment: { label: stage.garment.label, description: stage.garment.description },
            occasion,
            brief: skin.brief,
          });
          // A newer request (occasion change / new try-on) supersedes this one.
          if (get().verdictSeq !== seq) return;
          set({ verdict, verdictStatus: 'done' });
          const [thumb, resultSmall] = await Promise.all([
            resizeDataURL(stage.garment.crop, 260, 0.8),
            resizeDataURL(stage.result, 700, 0.82),
          ]);
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
          const [thumb, resultSmall] = await Promise.all([
            resizeDataURL(stage.garment.crop, 260, 0.8),
            resizeDataURL(stage.result, 700, 0.82),
          ]);
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

      openLookbookEntry: (id) => {
        const entry = get().lookbook.find((e) => e.id === id);
        if (!entry) return;
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

      resetAll: () =>
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
        }),
    }),
    {
      name: 'anywear',
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
