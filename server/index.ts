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

function decodeImage(b64: string): Buffer {
  return Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
}

app.onError((err, c) => {
  console.error('[api]', err);
  if (err instanceof YouCamError) {
    return c.json({ error: friendlyError(err.code, err.message), code: err.code }, 502);
  }
  return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    youcam: Boolean(process.env.YOUCAM_API_KEY && process.env.YOUCAM_SECRET_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  }),
);

app.get('/api/credits', async (c) => {
  const units = await getCredits();
  return c.json({ units });
});

// Upload a user photo once; the returned file_id is reused for every try-on.
app.post('/api/upload', async (c) => {
  const { imageBase64, mime, name } = await c.req.json<{ imageBase64: string; mime: string; name?: string }>();
  const fileId = await uploadImage(decodeImage(imageBase64), mime, name ?? 'photo.jpg');
  return c.json({ fileId });
});

// --- Skin analysis -------------------------------------------------------

app.post('/api/skin/start', async (c) => {
  const { imageBase64, mime } = await c.req.json<{ imageBase64: string; mime: string }>();
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
  const { imageBase64, mime } = await c.req.json<{ imageBase64: string; mime: string }>();
  const garments = await detectGarments(imageBase64.replace(/^data:[^;]+;base64,/, ''), mime);
  return c.json({ garments });
});

// --- Clothes try-on ------------------------------------------------------

app.post('/api/vto/start', async (c) => {
  const body = await c.req.json<{
    personFileId: string;
    garmentBase64: string;
    mime: string;
    category: GarmentCategory;
  }>();
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
  const imgRes = await fetch(body.tryOnUrl);
  if (!imgRes.ok) return c.json({ error: 'Could not fetch try-on image (URL may have expired)' }, 502);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mime = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const verdict = await stylistVerdict({
    tryOnImageBase64: buf.toString('base64'),
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
  if (!url || !/^https:\/\/[a-z0-9.-]+\.(amazonaws|makeupar|perfectcorp)\.com\//i.test(url)) {
    return c.json({ error: 'invalid url' }, 400);
  }
  const res = await fetch(url);
  if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502);
  c.header('Content-Type', res.headers.get('content-type') ?? 'image/jpeg');
  c.header('Cache-Control', 'private, max-age=3600');
  return c.body(await res.arrayBuffer());
});

// --- Static (production) -------------------------------------------------

if (process.env.NODE_ENV === 'production') {
  app.use('*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`anywear server on http://localhost:${port}`);
});
