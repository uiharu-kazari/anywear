import crypto from 'node:crypto';

const BASE = 'https://yce-api-01.perfectcorp.com';
const API_KEY = process.env.YOUCAM_API_KEY!;
const SECRET_KEY = process.env.YOUCAM_SECRET_KEY!;

// ---------------------------------------------------------------------------
// Auth: RSA-encrypted id_token -> short-lived access token, cached in memory.
// ---------------------------------------------------------------------------

let cachedToken: { token: string; obtainedAt: number } | null = null;
const TOKEN_TTL_MS = 90 * 60 * 1000;

async function authenticate(): Promise<string> {
  const pem = `-----BEGIN PUBLIC KEY-----\n${SECRET_KEY.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
  const payload = `client_id=${API_KEY}&timestamp=${Date.now()}`;
  const idToken = crypto
    .publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(payload))
    .toString('base64');
  const res = await fetch(`${BASE}/s2s/v1.0/client/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: API_KEY, id_token: idToken }),
  });
  const json = (await res.json()) as { result?: { access_token?: string } };
  const token = json?.result?.access_token;
  if (!res.ok || !token) throw new Error(`YouCam auth failed (HTTP ${res.status})`);
  cachedToken = { token, obtainedAt: Date.now() };
  return token;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.obtainedAt < TOKEN_TTL_MS) return cachedToken.token;
  return authenticate();
}

async function yc<T>(path: string, init?: RequestInit & { retryAuth?: boolean }): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 && init?.retryAuth !== false) {
    cachedToken = null;
    return yc<T>(path, { ...init, retryAuth: false });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
  if (!res.ok) {
    const err = (json as { error?: string; error_code?: string }) ?? {};
    throw new YouCamError(err.error ?? `HTTP ${res.status}`, err.error_code, res.status);
  }
  return json;
}

export class YouCamError extends Error {
  constructor(
    message: string,
    public code?: string,
    public httpStatus?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// File API: request an upload slot, then PUT the bytes to the presigned URL.
// ---------------------------------------------------------------------------

interface FileSlot {
  file_id: string;
  requests: { method: string; url: string; headers: Record<string, string> }[];
}

export async function uploadImage(buffer: Buffer, contentType: string, fileName: string): Promise<string> {
  const resp = await yc<{ data: { files: FileSlot[] } }>('/s2s/v2.0/file', {
    method: 'POST',
    body: JSON.stringify({
      files: [{ content_type: contentType, file_name: fileName, file_size: buffer.byteLength }],
    }),
  });
  const slot = resp.data?.files?.[0];
  const req = slot?.requests?.[0];
  if (!slot || !req) throw new YouCamError('file API returned no upload slot');
  const put = await fetch(req.url, {
    method: req.method || 'PUT',
    headers: req.headers,
    body: new Uint8Array(buffer),
  });
  if (!put.ok) throw new YouCamError(`upload PUT failed (HTTP ${put.status})`);
  return slot.file_id;
}

// ---------------------------------------------------------------------------
// AI Skin Analysis
// ---------------------------------------------------------------------------

// 7 SD concerns (12 units/analysis) + skin_type; SD needs short side >= 480px.
export const SKIN_ACTIONS = ['redness', 'oiliness', 'moisture', 'radiance', 'acne', 'texture', 'skin_type'];

export async function startSkinAnalysis(fileId: string): Promise<string> {
  const resp = await yc<{ data: { task_id: string } }>('/s2s/v2.0/task/skin-analysis', {
    method: 'POST',
    body: JSON.stringify({
      src_file_id: fileId,
      dst_actions: SKIN_ACTIONS,
      miniserver_args: { enable_mask_overlay: true },
      format: 'json',
    }),
  });
  return resp.data.task_id;
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

export interface TaskStatus<T> {
  task_status: 'running' | 'success' | 'error';
  error?: string | null;
  error_message?: string;
  result?: T;
}

export async function getSkinAnalysis(taskId: string): Promise<TaskStatus<SkinOutput[]>> {
  const resp = await yc<{
    data: {
      task_status: 'running' | 'success' | 'error';
      error?: string | null;
      error_message?: string;
      results?: { output?: SkinOutput[] };
    };
  }>(`/s2s/v2.0/task/skin-analysis/${encodeURIComponent(taskId)}`);
  const d = resp.data;
  return {
    task_status: d.task_status,
    error: d.error,
    error_message: d.error_message,
    result: d.results?.output,
  };
}

// ---------------------------------------------------------------------------
// AI Clothes Virtual Try-On (v4 engine)
// ---------------------------------------------------------------------------

export type GarmentCategory = 'upper_body' | 'lower_body' | 'full_body' | 'outer' | 'shoes' | 'auto';

export async function startClothesTryOn(opts: {
  personFileId: string;
  garmentFileId: string;
  category: GarmentCategory;
}): Promise<string> {
  const resp = await yc<{ data: { task_id: string } }>('/s2s/v2.0/task/cloth-v4', {
    method: 'POST',
    body: JSON.stringify({
      src_file_id: opts.personFileId,
      ref_file_id: opts.garmentFileId,
      garment_category: opts.category,
    }),
  });
  return resp.data.task_id;
}

export async function getClothesTryOn(taskId: string): Promise<TaskStatus<string>> {
  const resp = await yc<{
    data: {
      task_status: 'running' | 'success' | 'error';
      error?: string | null;
      error_message?: string;
      results?: { url?: string };
    };
  }>(`/s2s/v2.0/task/cloth-v4/${encodeURIComponent(taskId)}`);
  const d = resp.data;
  return {
    task_status: d.task_status,
    error: d.error,
    error_message: d.error_message,
    result: d.results?.url,
  };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export async function getCredits(): Promise<number> {
  const resp = await yc<{ results?: { amount_dec?: number }[]; result?: { amount_dec?: number }[] }>(
    '/s2s/v1.0/client/credit',
  );
  const rows = resp.results ?? resp.result ?? [];
  return rows.reduce((sum, r) => sum + (Number(r.amount_dec) || 0), 0);
}

// Friendly messages for engine/preprocess error codes.
const ERROR_HINTS: Record<string, string> = {
  error_no_face: 'No face detected — use a clear, front-facing photo.',
  error_src_face_too_small: 'Face too small — the face should fill most of the frame.',
  error_src_face_out_of_bound: 'Face partially out of frame — retake with the whole face visible.',
  error_lighting_dark: 'The photo is too dark — retake in brighter, even light.',
  error_below_min_image_size: 'Image resolution too low — use a larger photo.',
  error_exceed_max_image_size: 'Image too large — use a photo under 4096px.',
  exceed_max_filesize: 'File too large — keep images under 10MB.',
  error_pose: 'Pose not supported — use a front-facing, standing photo.',
  error_invalid_ref: 'The garment image could not be used — try a cleaner product photo or screenshot crop.',
  error_apply_region_mismatch: 'Garment type does not match the selected region — try a different category.',
  error_invalid_src: 'Your photo could not be used — use a front-facing, standing, single-person photo.',
  error_multiple_people: 'Multiple people detected — use a photo with just you.',
  error_nsfw_content_detected: 'The image was flagged by content moderation.',
  error_editing_failed: 'The engine could not produce a distinct result — try another garment image.',
  unknown_internal_error: 'The AI engine hit an internal error — try again.',
};

export function friendlyError(code?: string | null, fallback?: string): string {
  if (code && ERROR_HINTS[code]) return ERROR_HINTS[code];
  return fallback || code || 'Something went wrong.';
}
