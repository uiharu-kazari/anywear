// Self-hosted web build: the same UI on our own server's /api (YouCam + Gemini).

import { GARMENT_ONE, VERDICT, expect, test, type WebApp } from './support/harness';

async function enterStudio(web: WebApp) {
  await web.open();
  await web.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
  await expect(web.ui.getByText('Drop any screenshot')).toBeVisible();
}

/** A status endpoint that reports `running` for the first `n` polls. */
function runningFor(n: number, done: object) {
  let polls = 0;
  return () => ({ json: polls++ < n ? { status: 'running' } : done });
}

test('full flow on the web build, restored after reload', async ({ web, webApi, page }) => {
  await web.open();
  const ui = web.ui;
  await expect(ui.getByText('Powered by YouCam Skin AI · Apparel VTO · Gemini')).toBeVisible();
  await ui.getByRole('button', { name: 'Use my own photos' }).click();
  await expect(ui.getByText("Photos are sent to Perfect Corp's YouCam AI", { exact: false })).toBeVisible();
  await ui.getByRole('button', { name: 'Back' }).click();
  await ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
  await expect(ui.getByText('412 youcam units')).toBeVisible();
  await expect(ui.getByText('youcam skin ai + apparel vto · gemini styling brain · not medical advice')).toBeVisible();
  expect(webApi.calls.find((c) => c.path === '/api/upload')!.body.name).toBe('twin.jpg');

  // Skin: one running poll, then scores with masks, skin type and age.
  await expect(ui.getByText('Seven concerns, scored by YouCam Skin AI in seconds.')).toBeVisible();
  webApi.set('GET /api/skin/status', (() => {
    let polls = 0;
    return () =>
      polls++ < 1
        ? { json: { status: 'running' } }
        : {
            json: {
              status: 'success',
              output: [
                { type: 'redness', ui_score: 64, raw_score: 40, mask_urls: ['https://yce.test/mask-redness.png'] },
                { type: 'oiliness', ui_score: 71, raw_score: 55, mask_urls: ['https://yce.test/mask-broken.png'] },
                { type: 'moisture', ui_score: 58 },
                { type: 'skin_type', skin_type: 'combination' },
                { type: 'skin_age', score: 27.4 },
                { type: 'all', ui_score: 70 },
                { type: 'wrinkle' },
              ],
            },
          };
  })());
  await ui.getByRole('button', { name: 'Read my skin' }).click();
  await expect(ui.getByText('Reading your skin…')).toBeVisible();
  await expect(ui.getByText(/type · combination\s+·\s+skin age · 27/)).toBeVisible({ timeout: 8_000 });
  expect(webApi.calls.find((c) => c.path === '/api/skin/brief')!.body.concerns).toEqual([
    { type: 'redness', raw_score: 40, ui_score: 64 },
    { type: 'oiliness', raw_score: 55, ui_score: 71 },
    { type: 'moisture', raw_score: 0, ui_score: 58 },
  ]);

  // Detection masks: show one, close it; a mask that fails to load falls back.
  webApi.proxyStatus = (u) => (u.includes('broken') ? 502 : 200);
  await ui.getByRole('button', { name: /Redness/ }).click();
  await expect(ui.getByRole('button', { name: 'Redness ✕' })).toBeVisible();
  await expect(ui.getByRole('img', { name: 'Your selfie' })).toHaveAttribute('src', /image-proxy/);
  await ui.getByRole('button', { name: 'Redness ✕' }).click();
  await expect(ui.getByRole('img', { name: 'Your selfie' })).toHaveAttribute('src', /^data:/);
  await ui.getByRole('button', { name: /Oil balance/ }).click();
  await expect(ui.getByRole('img', { name: 'Your selfie' })).toHaveAttribute('src', /^data:/);
  await expect(ui.getByRole('button', { name: 'Oil balance ✕' })).toHaveCount(0);
  webApi.proxyStatus = () => 200;

  // Screenshot → pick → try-on (polls) → verdict.
  webApi.set('GET /api/vto/status', runningFor(1, { status: 'success', url: 'https://yce.test/vto.jpg' }));
  await ui.getByRole('button', { name: 'Street-style photo' }).click();
  await ui.getByRole('button', { name: 'Sage slip dress' }).click();
  await expect(ui.getByRole('img', { name: 'You wearing Sage slip dress' })).toBeVisible({ timeout: 10_000 });
  await expect(ui.locator('p', { hasText: /✓\s+Wear it/ })).toBeVisible();
  const vto = webApi.calls.find((c) => c.path === '/api/vto/start')!.body;
  expect(vto).toMatchObject({ personFileId: 'file-twin', mime: 'image/jpeg', category: 'full_body' });
  const verdictBody = webApi.calls.find((c) => c.path === '/api/stylist/verdict')!.body;
  expect(verdictBody.tryOnUrl).toBe('https://yce.test/vto.jpg');
  expect(verdictBody).not.toHaveProperty('tryOnDataUrl');
  expect(verdictBody.brief.headline).toBeTruthy();

  // Reload: everything comes back from localStorage.
  await page.waitForTimeout(100);
  await web.reopen();
  await expect(ui.getByRole('img', { name: 'Your full-body photo' })).toBeVisible();
  await expect(ui.getByRole('region', { name: 'Lookbook' }).getByRole('button')).toHaveCount(1);
});

test('server failures on the web build', async ({ web, webApi }) => {
  webApi.set('GET /api/credits', () => ({ status: 503, json: { error: 'credits unavailable' } }));
  webApi.set('POST /api/upload', () => ({ status: 500, body: 'oops' }));
  await enterStudio(web);
  const ui = web.ui;
  await expect(ui.getByText('youcam units')).toHaveCount(0);

  // Skin: start refused, then the task errors with and without a reason, then no output.
  webApi.set('POST /api/skin/start', () => ({ status: 400, json: { error: 'Selfie too dark' } }));
  await ui.getByRole('button', { name: 'Read my skin' }).click();
  await expect(ui.getByText('Selfie too dark')).toBeVisible();
  webApi.set('POST /api/skin/start', () => ({ json: { taskId: 'skin/2' } }));
  webApi.set('GET /api/skin/status', () => ({ json: { status: 'error', error: 'No face found' } }));
  await ui.getByRole('button', { name: 'Retry' }).click();
  await expect(ui.getByText('No face found')).toBeVisible();
  webApi.set('GET /api/skin/status', () => ({ json: { status: 'error' } }));
  await ui.getByRole('button', { name: 'Retry' }).click();
  await expect(ui.getByText('Skin analysis failed.')).toBeVisible();
  webApi.set('GET /api/skin/status', () => ({ status: 502, body: 'bad gateway' }));
  await ui.getByRole('button', { name: 'Retry' }).click();
  await expect(ui.getByText('Request failed (502)')).toBeVisible();
  webApi.set('GET /api/skin/status', () => ({ json: { status: 'success' } }));
  webApi.set('POST /api/skin/brief', () => ({ status: 500, json: { error: 'gemini down' } }));
  await ui.getByRole('button', { name: 'Retry' }).click();
  await expect(ui.getByText('Brief unavailable.')).toBeVisible();
  expect(webApi.calls.some((c) => c.path === '/api/skin/status/skin%2F2')).toBe(true);

  // Detection error.
  webApi.set('POST /api/garments/detect', () => ({ status: 500, json: { error: 'Gemini quota' } }));
  await ui.getByRole('button', { name: 'Street-style photo' }).click();
  await expect(ui.getByText('Gemini quota')).toBeVisible();
  await ui.getByRole('button', { name: 'Start over' }).click();

  // Try-on: the twin upload failed at setup → retried here, failing again.
  webApi.set('POST /api/garments/detect', () => ({ json: { garments: GARMENT_ONE } }));
  await ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(ui.getByText('Request failed (500)')).toBeVisible();
  await ui.getByRole('button', { name: 'Start over' }).click();
  expect(webApi.count('POST /api/upload')).toBe(2);

  webApi.set('POST /api/upload', () => ({ json: { fileId: 'file-2' } }));
  const failures: [object, string][] = [
    [{ status: 'error', error: 'Garment not supported' }, 'Garment not supported'],
    [{ status: 'error' }, 'Try-on failed.'],
    [{ status: 'success' }, 'Try-on failed.'],
  ];
  for (const [status, message] of failures) {
    webApi.set('GET /api/vto/status', () => ({ json: status }));
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(ui.getByText(message)).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();
  }
  // A server error without a message.
  webApi.set('POST /api/vto/start', () => ({ status: 500, json: { error: '' } }));
  await ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(ui.getByText('Try-on failed.')).toBeVisible();
  await ui.getByRole('button', { name: 'Start over' }).click();
  webApi.routes.delete('POST /api/vto/start');
  webApi.set('POST /api/vto/start', () => ({ json: { taskId: 'vto-1' } }));

  // The try-on finished but its image can't be fetched.
  webApi.set('GET /api/vto/status', () => ({ json: { status: 'success', url: 'https://yce.test/gone.jpg' } }));
  webApi.proxyStatus = () => 404;
  await ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(ui.getByText('Could not load the image.')).toBeVisible();
  await ui.getByRole('button', { name: 'Start over' }).click();
  // Each failure dropped the stored twin file, so every attempt re-uploaded it.
  expect(webApi.count('POST /api/upload')).toBe(7);

  // Verdict from the server fails → Ask again works.
  webApi.proxyStatus = () => 200;
  webApi.set('GET /api/vto/status', () => ({ json: { status: 'success', url: 'https://yce.test/vto.jpg' } }));
  webApi.set('POST /api/stylist/verdict', () => ({ status: 500, json: { error: 'busy' } }));
  await ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
  webApi.set('POST /api/stylist/verdict', () => ({ json: { verdict: VERDICT } }));
  await ui.getByRole('button', { name: 'Ask again' }).click();
  await expect(ui.locator('p', { hasText: /✓\s+Wear it/ })).toBeVisible();
});

test('a skin read that never finishes times out', async ({ web, webApi, page }) => {
  await page.clock.install();
  await enterStudio(web);
  webApi.set('GET /api/skin/status', () => ({ json: { status: 'running' } }));
  await web.ui.getByRole('button', { name: 'Read my skin' }).click();
  await expect.poll(() => webApi.count('GET /api/skin/status')).toBe(1);
  await page.clock.fastForward('03:05');
  await expect(web.ui.getByText('The AI task timed out — try again.')).toBeVisible();
});

test('Start fresh while a screenshot is being read (web)', async ({ web, webApi }) => {
  await enterStudio(web);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  webApi.set('POST /api/garments/detect', async () => {
    await held;
    return { json: { garments: GARMENT_ONE } };
  });
  await web.ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(web.ui.getByText('reading the look…')).toBeVisible();
  await web.ui.getByRole('button', { name: 'Start fresh' }).click();
  await web.ui.getByRole('button', { name: /Click again to clear/ }).click();
  await expect(web.ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
  release();
  await web.page.waitForTimeout(500);
  expect(webApi.count('POST /api/vto/start')).toBe(0);
});
