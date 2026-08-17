// Same server as the web app. Defaults to the live Cloud Run backend so the
// mobile app works out of the box; override with EXPO_PUBLIC_API_BASE_URL to
// point at a local server (e.g. http://<your-lan-ip>:8931).
export const API =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://anywear-1065701526224.asia-northeast1.run.app';

export interface DetectedGarment {
  label: string;
  category: 'upper_body' | 'lower_body' | 'full_body';
  box_2d: [number, number, number, number];
  description: string;
  confidence: number;
}

export interface SkinOutput {
  type: string;
  raw_score?: number;
  ui_score?: number;
  score?: number;
  skin_type?: string;
  mask_urls?: string[];
}

export interface SkinBrief {
  headline: string;
  summary: string;
  care_focus: { title: string; why: string; action: string }[];
  palette: {
    guidance: string;
    wear: { hex: string; name: string; why: string }[];
    avoid: { hex: string; name: string; why: string }[];
  };
}

export interface StylistVerdict {
  verdict: 'wear_it' | 'maybe' | 'skip';
  score: number;
  headline: string;
  reasons: string[];
  skin_harmony: string;
  pairing: string[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

const post = <T,>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  uploadPhoto: (imageBase64: string) =>
    post<{ fileId: string }>('/api/upload', { imageBase64, mime: 'image/jpeg', name: 'twin.jpg' }),
  skinStart: (imageBase64: string) =>
    post<{ taskId: string }>('/api/skin/start', { imageBase64, mime: 'image/jpeg' }),
  skinStatus: (taskId: string) =>
    req<{ status: string; output?: SkinOutput[]; error?: string }>(`/api/skin/status/${encodeURIComponent(taskId)}`),
  skinBrief: (concerns: { type: string; raw_score: number; ui_score: number }[]) =>
    post<{ brief: SkinBrief }>('/api/skin/brief', { concerns }),
  detect: (imageBase64: string) =>
    post<{ garments: DetectedGarment[] }>('/api/garments/detect', { imageBase64, mime: 'image/jpeg' }),
  vtoStart: (personFileId: string, garmentBase64: string, category: string) =>
    post<{ taskId: string }>('/api/vto/start', { personFileId, garmentBase64, mime: 'image/jpeg', category }),
  vtoStatus: (taskId: string) =>
    req<{ status: string; url?: string; error?: string }>(`/api/vto/status/${encodeURIComponent(taskId)}`),
  verdict: (args: {
    tryOnUrl: string;
    garment: { label: string; description: string };
    occasion: string;
    brief?: SkinBrief | null;
  }) => post<{ verdict: StylistVerdict }>('/api/stylist/verdict', args),
};

export const proxied = (url: string) => `${API}/api/image-proxy?url=${encodeURIComponent(url)}`;

export async function pollUntilDone<T extends { status: string }>(
  fn: () => Promise<T>,
  intervalMs = 3000,
  timeoutMs = 180_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const st = await fn();
    if (st.status !== 'running') return st;
    if (Date.now() - startedAt > timeoutMs) throw new Error('The AI task timed out — try again.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
