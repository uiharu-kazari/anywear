import {
  BRIEF_JSON_SHAPE,
  GARMENT_JSON_SHAPE,
  GARMENT_PROMPT,
  SKIN_READ_JSON_SHAPE,
  SKIN_READ_PROMPT,
  VERDICT_JSON_SHAPE,
  skinBriefPrompt,
  tryOnPrompt,
  validateBrief,
  validateGarments,
  validateSkinRead,
  validateVerdict,
  verdictPrompt,
  type DetectedGarment,
  type SkinBrief,
  type SkinConcern,
  type StylistVerdict,
} from '../../shared/prompts';
import { IS_ANNA, freshUploadUrl, generateImage, llmJSON, uploadDataUrl } from './anna';

export type { DetectedGarment, SkinBrief, StylistVerdict };

export interface SkinOutput {
  type: string;
  region?: string;
  raw_score?: number;
  ui_score?: number;
  score?: number;
  skin_type?: string;
  mask_urls?: string[];
}

// Web build (self-hosted): YouCam + Gemini via our own server, same-origin.
// Anna build: no backend at all — every AI step runs on Anna's host APIs and is
// billed to the user's Anna credits.
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const CLIENT_HEADERS: Record<string, string> = IS_ANNA ? { 'X-Anywear-Client': 'anna' } : {};

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path, { headers: CLIENT_HEADERS });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export const api = {
  credits: () => get<{ units: number }>('/api/credits'),

  uploadPhoto: (imageBase64: string, mime: string, name: string) =>
    post<{ fileId: string }>('/api/upload', { imageBase64, mime, name }),

  skinStart: (imageBase64: string, mime: string) =>
    post<{ taskId: string }>('/api/skin/start', { imageBase64, mime }),

  skinStatus: (taskId: string) =>
    get<{ status: 'running' | 'success' | 'error'; output?: SkinOutput[]; error?: string }>(
      `/api/skin/status/${encodeURIComponent(taskId)}`,
    ),

  skinBrief: (concerns: SkinConcern[]) =>
    viaAnna(
      async () => ({
        brief: await llmJSON({ prompt: skinBriefPrompt(concerns), shape: BRIEF_JSON_SHAPE, parse: validateBrief }),
      }),
      () => post<{ brief: SkinBrief }>('/api/skin/brief', { concerns }),
    ),

  detectGarments: (imageBase64: string, mime: string) =>
    viaAnna(
      async () => ({
        garments: await llmJSON({
          prompt: GARMENT_PROMPT,
          shape: GARMENT_JSON_SHAPE,
          image: `data:${mime};base64,${imageBase64}`,
          parse: validateGarments,
        }),
      }),
      () => post<{ garments: DetectedGarment[] }>('/api/garments/detect', { imageBase64, mime }),
    ),

  vtoStart: (personFileId: string, garmentBase64: string, mime: string, category: string) =>
    post<{ taskId: string }>('/api/vto/start', { personFileId, garmentBase64, mime, category }),

  vtoStatus: (taskId: string) =>
    get<{ status: 'running' | 'success' | 'error'; url?: string; error?: string }>(
      `/api/vto/status/${encodeURIComponent(taskId)}`,
    ),

  verdict: (args: {
    tryOnUrl: string;
    /** The try-on image as we hold it (data: URL, or an https URL in Anna). */
    tryOnDataUrl: string;
    garment: { label: string; description: string };
    occasion: string;
    brief?: SkinBrief | null;
  }) =>
    viaAnna(
      async () => ({
        verdict: await llmJSON({
          prompt: verdictPrompt(args),
          shape: VERDICT_JSON_SHAPE,
          image: args.tryOnDataUrl,
          parse: validateVerdict,
        }),
      }),
      () => {
        const { tryOnDataUrl: _drop, ...body } = args;
        return post<{ verdict: StylistVerdict }>('/api/stylist/verdict', body);
      },
    ),
};

/** Anna edition only: the AI steps YouCam handles on the self-hosted web build. */
export const annaApi = {
  /** Visual skin read of a selfie by the user's Anna vision model. */
  skinRead: (selfieDataUrl: string): Promise<SkinOutput[]> =>
    llmJSON({ prompt: SKIN_READ_PROMPT, shape: SKIN_READ_JSON_SHAPE, image: selfieDataUrl, parse: validateSkinRead, maxTokens: 512 }),

  /** Upload the twin photo once; the returned key is durable. */
  uploadTwin: async (dataUrl: string) => (await uploadDataUrl(dataUrl, 'twin.jpg')).r2Key,

  /** Virtual try-on via Anna image generation (person + garment references). */
  tryOn: async (opts: {
    twinKey: string | null;
    twinPhoto: string;
    garment: { label: string; description: string; category: string; crop: string };
    size: string;
    aspectRatio: string;
  }): Promise<{ url: string; twinKey: string }> => {
    let twinKey = opts.twinKey;
    let personUrl: string | null = null;
    if (twinKey) personUrl = await freshUploadUrl(twinKey).catch(() => null);
    if (!personUrl || !twinKey) {
      const up = await uploadDataUrl(opts.twinPhoto, 'twin.jpg');
      twinKey = up.r2Key;
      personUrl = up.url;
    }
    const garmentUrl = (await uploadDataUrl(opts.garment.crop, 'garment.jpg')).url;
    const url = await generateImage({ prompt: tryOnPrompt(opts.garment), referenceUrls: [personUrl, garmentUrl], size: opts.size, aspectRatio: opts.aspectRatio });
    return { url, twinKey };
  },
};

export function proxied(url: string): string {
  return `${API_BASE}/api/image-proxy?url=${encodeURIComponent(url)}`;
}

/** Anna build: run on the user's Anna model (no server to fall back to).
 * Web build: run on our own server. */
function viaAnna<T>(annaFn: () => Promise<T>, serverFn: () => Promise<T>): Promise<T> {
  return IS_ANNA ? annaFn() : serverFn();
}

/** Poll a status endpoint until it leaves `running`. */
export async function pollUntilDone<T extends { status: string }>(
  fn: () => Promise<T>,
  opts: { intervalMs: number; timeoutMs?: number },
): Promise<T> {
  const { intervalMs, timeoutMs = 180_000 } = opts;
  const startedAt = Date.now();
  for (;;) {
    const st = await fn();
    if (st.status !== 'running') return st;
    if (Date.now() - startedAt > timeoutMs) throw new Error('The AI task timed out — try again.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
