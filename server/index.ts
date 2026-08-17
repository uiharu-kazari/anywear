import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import {
  uploadImage,
  startSkinAnalysis,
  getSkinAnalysis,
  startClothesTryOn,
  getClothesTryOn,
  getCredits,
  friendlyError,
  YouCamError,
  type GarmentCategory,
} from './youcam.js';
import { detectGarments, skinBrief, stylistVerdict, type SkinBrief } from './gemini.js';

const app = new Hono();
const IS_PROD = process.env.NODE_ENV === 'production';

function decodeImage(b64: string): Buffer {
  return Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
}

// --- Abuse guards ----------------------------------------------------------

// Only YouCam's result CDN is allowed as a fetch target (verdict + proxy).
// This is the SSRF allowlist: exact host suffixes, https only, no redirects.
const ALLOWED_IMAGE_HOSTS = /(^|\.)(s3-accelerate\.amazonaws\.com|s3\.[a-z0-9-]+\.amazonaws\.com|makeupar\.com|perfectcorp\.com)$/i;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB — YouCam results are well under this
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // decoded image cap for uploads

function isAllowedImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.test(u.hostname);
}

/** Fetch an image from the YouCam CDN only: https, allowlisted host, no
 * redirects, size + time capped, and the response is forced to an image type
 * so a hostile upstream can never make us serve HTML/JS under our origin. */
async function fetchImageSafely(raw: string): Promise<{ buffer: Buffer; mime: string }> {
  if (!isAllowedImageUrl(raw)) throw new HttpError(400, 'Invalid image URL.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(raw, { redirect: 'error', signal: controller.signal });
    if (!res.ok) throw new HttpError(502, `Upstream image error (${res.status}).`);
    const upstreamType = (res.headers.get('content-type') ?? '').toLowerCase();
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared && declared > MAX_IMAGE_BYTES) throw new HttpError(502, 'Image too large.');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new HttpError(502, 'Image too large.');
    // Trust the upstream type only if it is an image; otherwise fall back to jpeg.
    const mime = upstreamType.startsWith('image/') ? upstreamType : 'image/jpeg';
    return { buffer, mime };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'Could not fetch the image (it may have expired).');
  } finally {
    clearTimeout(timer);
  }
}

class HttpError extends Error {
  constructor(
    public status: 400 | 402 | 413 | 429 | 502,
    message: string,
  ) {
    super(message);
  }
}

// Per-IP sliding-window rate limit + a global daily spend ceiling so a public
// URL can't drain the API budget. In-memory (single instance / best-effort).
const RATE_WINDOW_MS = 60_000;
// Generous per-IP flood guard: normal use polls task status every ~3s, so one
// active session stays well under this; a scripted flood does not.
const RATE_MAX = 90; // requests/min/IP across all routes
const COST_WINDOW_MS = 24 * 60 * 60 * 1000;
// Global ceiling on paid calls/day so a public URL can't drain the unit budget.
// Worst case (all try-ons) ~= 2 units each; 150 caps damage at ~300 units.
const COST_MAX_PER_DAY = 150;
const hits = new Map<string, number[]>();
let costEvents: number[] = [];

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  const fwd = c.req.header('x-forwarded-for');
  return (fwd?.split(',')[0] || c.req.header('x-real-ip') || 'unknown').trim();
}

function rateLimit(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) throw new HttpError(429, 'Too many requests — slow down a moment.');
  arr.push(now);
  hits.set(ip, arr);
}

function chargeGuard() {
  const now = Date.now();
  costEvents = costEvents.filter((t) => now - t < COST_WINDOW_MS);
  if (costEvents.length >= COST_MAX_PER_DAY) throw new HttpError(402, 'Daily demo limit reached — please try again tomorrow.');
  costEvents.push(now);
}

// Rate-limit every /api route.
app.use('/api/*', async (c, next) => {
  if (c.req.path !== '/api/health') rateLimit(clientIp(c));
  await next();
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('[api]', err);
  if (err instanceof YouCamError) {
    return c.json({ error: friendlyError(err.code, err.message), code: err.code }, 502);
  }
  // Never leak raw exception text to the public in production.
  return c.json({ error: IS_PROD ? 'Something went wrong on our side.' : String(err) }, 500);
});

/** Parse a JSON body and enforce a decoded-image size cap on base64 fields. */
async function readImageBody<T extends { imageBase64?: string; garmentBase64?: string }>(c: {
  req: { json: <U>() => Promise<U> };
}): Promise<T> {
  const body = await c.req.json<T>();
  for (const field of ['imageBase64', 'garmentBase64'] as const) {
    const v = body[field];
    if (typeof v === 'string' && v.length * 0.75 > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'Image is too large — please use a smaller photo.');
    }
  }
  return body;
}

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    youcam: Boolean(process.env.YOUCAM_API_KEY && process.env.YOUCAM_SECRET_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT),
  }),
);

app.get('/api/credits', async (c) => {
  const units = await getCredits();
  return c.json({ units });
});

// Upload a user photo once; the returned file_id is reused for every try-on.
app.post('/api/upload', async (c) => {
  const { imageBase64, mime, name } = await readImageBody<{ imageBase64: string; mime: string; name?: string }>(c);
  const fileId = await uploadImage(decodeImage(imageBase64), mime, name ?? 'photo.jpg');
  return c.json({ fileId });
});

// --- Skin analysis -------------------------------------------------------

app.post('/api/skin/start', async (c) => {
  const { imageBase64, mime } = await readImageBody<{ imageBase64: string; mime: string }>(c);
  chargeGuard();
  const fileId = await uploadImage(decodeImage(imageBase64), mime, 'selfie.jpg');
  const taskId = await startSkinAnalysis(fileId);
  return c.json({ taskId });
});

app.get('/api/skin/status/:taskId', async (c) => {
  const st = await getSkinAnalysis(c.req.param('taskId'));
  if (st.task_status === 'error') {
    return c.json({ status: 'error', error: friendlyError(st.error, st.error_message) });
  }
  if (st.task_status === 'success') {
    return c.json({ status: 'success', output: st.result ?? [] });
  }
  return c.json({ status: 'running' });
});

app.post('/api/skin/brief', async (c) => {
  const { concerns } = await c.req.json<{ concerns: { type: string; raw_score: number; ui_score: number }[] }>();
  const brief = await skinBrief(concerns);
  return c.json({ brief });
});

// --- Garment detection (Gemini vision over any screenshot) ---------------

app.post('/api/garments/detect', async (c) => {
  const { imageBase64, mime } = await readImageBody<{ imageBase64: string; mime: string }>(c);
  chargeGuard();
  const garments = await detectGarments(imageBase64.replace(/^data:[^;]+;base64,/, ''), mime);
  return c.json({ garments });
});

// --- Clothes try-on ------------------------------------------------------

app.post('/api/vto/start', async (c) => {
  const body = await readImageBody<{
    personFileId: string;
    garmentBase64: string;
    mime: string;
    category: GarmentCategory;
  }>(c);
  chargeGuard();
  const garmentFileId = await uploadImage(decodeImage(body.garmentBase64), body.mime, 'garment.jpg');
  const taskId = await startClothesTryOn({
    personFileId: body.personFileId,
    garmentFileId,
    category: body.category,
  });
  return c.json({ taskId });
});

app.get('/api/vto/status/:taskId', async (c) => {
  const st = await getClothesTryOn(c.req.param('taskId'));
  if (st.task_status === 'error') {
    return c.json({ status: 'error', error: friendlyError(st.error, st.error_message) });
  }
  if (st.task_status === 'success') {
    return c.json({ status: 'success', url: st.result });
  }
  return c.json({ status: 'running' });
});

// --- Stylist verdict (Gemini judges the finished try-on) -----------------

app.post('/api/stylist/verdict', async (c) => {
  const body = await c.req.json<{
    tryOnUrl: string;
    garment: { label: string; description: string };
    occasion: string;
    brief?: SkinBrief | null;
  }>();
  const { buffer, mime } = await fetchImageSafely(body.tryOnUrl);
  const verdict = await stylistVerdict({
    tryOnImageBase64: buffer.toString('base64'),
    mimeType: mime,
    garment: body.garment,
    occasion: body.occasion,
    brief: body.brief ?? null,
  });
  return c.json({ verdict });
});

// Proxy result images so the client can render/download without CORS issues
// and so expired S3 URLs fail with a clear message.
app.get('/api/image-proxy', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'invalid url' }, 400);
  const { buffer, mime } = await fetchImageSafely(url);
  // Force an image content-type and forbid sniffing, so a hostile upstream can
  // never get HTML/JS executed under our origin.
  c.header('Content-Type', mime);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:");
  c.header('Cache-Control', 'private, max-age=3600');
  return c.body(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
});

// Demo sample images as base64 (the Expo app consumes these).
app.get('/api/sample/:name', async (c) => {
  const name = c.req.param('name');
  if (!/^[a-z_]+\.(png|jpg)$/.test(name)) return c.json({ error: 'unknown sample' }, 400);
  const { readFile } = await import('node:fs/promises');
  try {
    const buf = await readFile(`./public/samples/${name}`);
    return c.json({ imageBase64: buf.toString('base64'), mime: name.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  } catch {
    return c.json({ error: 'unknown sample' }, 404);
  }
});

// --- Static ----------------------------------------------------------------

// Demo sample assets are always served (the Expo app loads them from here).
app.use('/samples/*', serveStatic({ root: './public' }));

if (process.env.NODE_ENV === 'production') {
  app.use('*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`anywear server on http://localhost:${port}`);
});
