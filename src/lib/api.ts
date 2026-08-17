export interface DetectedGarment {
  label: string;
  category: 'upper_body' | 'lower_body' | 'full_body';
  box_2d: [number, number, number, number]; // ymin,xmin,ymax,xmax in 0-1000
  description: string;
  confidence: number;
}

export interface SkinOutput {
  type: string;
  region?: string;
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
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

  skinBrief: (concerns: { type: string; raw_score: number; ui_score: number }[]) =>
    post<{ brief: SkinBrief }>('/api/skin/brief', { concerns }),

  detectGarments: (imageBase64: string, mime: string) =>
    post<{ garments: DetectedGarment[] }>('/api/garments/detect', { imageBase64, mime }),

  vtoStart: (personFileId: string, garmentBase64: string, mime: string, category: string) =>
    post<{ taskId: string }>('/api/vto/start', { personFileId, garmentBase64, mime, category }),

  vtoStatus: (taskId: string) =>
    get<{ status: 'running' | 'success' | 'error'; url?: string; error?: string }>(
      `/api/vto/status/${encodeURIComponent(taskId)}`,
    ),

  verdict: (args: {
    tryOnUrl: string;
    garment: { label: string; description: string };
    occasion: string;
    brief?: SkinBrief | null;
  }) => post<{ verdict: StylistVerdict }>('/api/stylist/verdict', args),
};

export function proxied(url: string): string {
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

/** Poll a status endpoint until it leaves `running`. */
export async function pollUntilDone<T extends { status: string }>(
  fn: () => Promise<T>,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const { intervalMs = 3000, timeoutMs = 180_000 } = opts;
  const startedAt = Date.now();
  for (;;) {
    const st = await fn();
    if (st.status !== 'running') return st;
    if (Date.now() - startedAt > timeoutMs) throw new Error('The AI task timed out — try again.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
