// Anna AI OS integration. Only active in the Anna build (`vite build --mode anna`),
// where the bundle runs inside a sandboxed Anna App window.

import { extractJSON } from '../../shared/prompts';

export const IS_ANNA = import.meta.env.VITE_TARGET === 'anna';

// Served by the Anna host; auto-allow-listed in the bundle's script-src.
const SDK_URL = '/static/anna-apps/_sdk/latest/index.js';

type RpcResult<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export interface AnnaRuntime {
  llm: { complete(args: object, opts?: { timeoutMs?: number }): Promise<unknown> };
  storage: {
    get(args: { key: string }): Promise<unknown>;
    set(args: { key: string; value: unknown }): Promise<unknown>;
    delete(args: { key: string }): Promise<unknown>;
    list(args: { prefix?: string; cursor?: string; limit?: number }): Promise<unknown>;
  };
  upload: {
    inline(args: { filename: string; mime_type: string; content_b64: string; purpose?: string }, opts?: { timeoutMs?: number }): Promise<unknown>;
    confirm(args: { r2_key: string }): Promise<unknown>;
  };
  image: {
    generate(args: object, opts?: { timeoutMs?: number }): Promise<unknown>;
  };
  window: { report_error(args: { message: string; stack?: string }): Promise<unknown> };
  theme?: 'light' | 'dark';
  locale?: string;
}

export class AnnaError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The host error code of a failed Anna call, if any. The SDK rejects with a
 * plain `Error` carrying `.code` (e.g. `APP_ERR_QUOTA_EXCEEDED`); an
 * `{ok:false}` envelope surfaces as our own AnnaError. Client-side failures
 * (e.g. an RPC timeout) have no code. */
export function annaErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** The SDK docs show both a bare result and an `{ok, result|error}` envelope;
 * accept either so we work across host versions. */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === 'object' && 'ok' in res) {
    const r = res as RpcResult<T>;
    if (r.ok) return r.result;
    throw new AnnaError(r.error?.code ?? 'unknown', r.error?.message ?? 'Anna request failed.');
  }
  return res as T;
}

let runtime: Promise<AnnaRuntime> | null = null;

/** Anna build only (every caller is on an IS_ANNA path). */
export function anna(): Promise<AnnaRuntime> {
  runtime ??= import(/* @vite-ignore */ SDK_URL).then((m: { AnnaAppRuntime: { connect(): Promise<AnnaRuntime> } }) =>
    m.AnnaAppRuntime.connect(),
  );
  return runtime;
}

// --- LLM ---------------------------------------------------------------------

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'image'; url: string };

/** A data: URL is sent inline; an https URL (e.g. a fresh Anna image result) by reference. */
export function imageContent(src: string): Content {
  const m = src.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { type: 'image', data: m[2], mimeType: m[1] } : { type: 'image', url: src };
}

/** One-shot completion that must return JSON, validated by `parse`. Retries
 * once with a stricter reminder if the model wraps or mangles the JSON. */
export async function llmJSON<T>(opts: {
  prompt: string;
  shape: string;
  /** data: URL or https URL */
  image?: string;
  parse: (raw: unknown) => T;
  maxTokens?: number;
}): Promise<T> {
  const rt = await anna();
  const content: Content[] = [];
  if (opts.image) content.push(imageContent(opts.image));
  content.push({ type: 'text', text: `${opts.prompt}\n\n${opts.shape}` });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: { role: 'user' | 'assistant'; content: Content[] | Content }[] = [{ role: 'user', content }];
    if (attempt > 0) {
      messages.push({ role: 'user', content: { type: 'text', text: 'Your previous reply was not valid JSON. Reply again with ONLY the JSON value.' } });
    }
    try {
      const reply = unwrap<{ content: { text: string } | { text: string }[] }>(
        await rt.llm.complete(
          {
            messages,
            maxTokens: opts.maxTokens ?? 2048,
            temperature: 0.4,
            // Soft hint only: the user's own model choice always wins. Gemini
            // is strongest at box_2d grounding, which garment crops depend on.
            modelPreferences: { hints: [{ name: 'gemini' }], intelligencePriority: 0.6, speedPriority: 0.6 },
          },
          { timeoutMs: 90_000 },
        ),
      );
      const text = Array.isArray(reply.content) ? reply.content.map((c) => c.text).join('') : reply.content.text;
      return opts.parse(extractJSON(text));
    } catch (err) {
      lastErr = err;
      // Quota / permission / non-vision model errors won't fix themselves on retry.
      if (annaErrorCode(err)) break;
    }
  }
  throw lastErr;
}

// --- Upload + image generation -------------------------------------------------

/** Put a data: URL into Anna's per-user storage. The r2_key is durable; the
 * download URL lives ~30 min (re-mint with `freshUploadUrl`). */
export async function uploadDataUrl(dataUrl: string, filename: string): Promise<{ r2Key: string; url: string }> {
  const rt = await anna();
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  // Callers only pass canvas output (always a data: URL).
  /* istanbul ignore next -- @preserve */
  if (!m) throw new Error('Expected an image data URL.');
  const r = unwrap<{ r2_key: string; download_url: string }>(
    await rt.upload.inline({ filename, mime_type: m[1], content_b64: m[2], purpose: 'image_reference' }, { timeoutMs: 60_000 }),
  );
  return { r2Key: r.r2_key, url: r.download_url };
}

export async function freshUploadUrl(r2Key: string): Promise<string> {
  const rt = await anna();
  return unwrap<{ download_url: string }>(await rt.upload.confirm({ r2_key: r2Key })).download_url;
}

/** Generate one image conditioned on reference images. Uses the sync call:
 * as of 2026-11 the async job path (generateAwait) re-hosts reference URLs in
 * a way fal cannot download ("image URL is not accessible"), while sync works. */
export async function generateImage(args: { prompt: string; referenceUrls: string[]; size: string; aspectRatio: string }): Promise<string> {
  const rt = await anna();
  const body = {
    prompt: args.prompt,
    n: 1,
    // Nano Banana sizes by aspect_ratio (+resolution); size-driven models use size.
    size: args.size,
    aspect_ratio: args.aspectRatio,
    resolution: '1K',
    reference_image_urls: args.referenceUrls,
    output_format: 'jpeg',
    // Soft hint: Nano Banana (Gemini image) keeps identity well across references.
    modelPreferences: { hints: [{ name: 'Nano Banana 2' }, { name: 'nano-banana' }] },
  };
  type Img = { url?: string | null };
  const res = unwrap<{ images?: Img[] }>(await rt.image.generate(body, { timeoutMs: 180_000 }));
  const url = res.images?.[0]?.url;
  if (!url) throw new Error('The try-on came back empty — please try again.');
  return url;
}

export function friendlyAnnaError(err: unknown): string {
  const code = annaErrorCode(err);
  if (code) {
    if (/QUOTA/i.test(code)) return 'You are out of Anna credits — top up in Anna and try again.';
    if (/CONTENT_REJECTED/i.test(code)) return 'The image model declined this one — try a different photo or garment.';
    if (/VISION/i.test(code)) return 'Your selected Anna model cannot read images — pick a vision model (e.g. Gemini) in Anna settings.';
  }
  // Everything we await rejects with an Error; keep a fallback for anything else.
  return err instanceof Error ? err.message : /* istanbul ignore next -- @preserve */ 'Something went wrong.';
}
