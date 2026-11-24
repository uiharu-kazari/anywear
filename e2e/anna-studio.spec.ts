// Anna edition: every screen, control and failure path of the studio.

import {
  BRIEF,
  GARMENTS_TWO,
  GARMENT_ONE,
  VERDICT,
  bare,
  envelopeError,
  expect,
  fixture,
  gate,
  llmText,
  ok,
  reject,
  sample,
  test,
  type AnnaApp,
} from './support/harness';

async function enterStudio(anna: AnnaApp) {
  await anna.open();
  await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
  await expect(anna.ui.getByText('Drop any screenshot')).toBeVisible();
}

/** Run a try-on of the single sample blazer and wait for the result. */
async function tryOnBlazer(anna: AnnaApp) {
  anna.host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
  await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(anna.ui.getByRole('img', { name: 'You wearing Camel blazer' })).toBeVisible();
}

test.describe('welcome', () => {
  test('use my own photos: slots, back, replace, enter', async ({ anna, page }) => {
    await anna.open();
    const ui = anna.ui;
    await expect(ui.getByText('Opening your fitting room…')).toBeHidden();
    await ui.getByRole('button', { name: 'Use my own photos' }).click();
    await expect(ui.getByText("Your photos are processed by Anna's AI models", { exact: false })).toBeVisible();
    await ui.getByRole('button', { name: 'Back' }).click();
    await ui.getByRole('button', { name: 'Use my own photos' }).click();

    const enter = ui.getByRole('button', { name: 'Enter the fitting room' });
    await expect(enter).toBeDisabled();

    // The slot button opens the file picker.
    const chooser = page.waitForEvent('filechooser');
    await ui.getByRole('button', { name: /Front-facing, standing/ }).click();
    await (await chooser).setFiles(sample('person.png'));
    await expect(ui.getByRole('img', { name: 'Full-body photo · required' })).toBeVisible();

    // Picking nothing leaves the photo as is.
    await ui.getByLabel('Full-body photo · required').setInputFiles([]);
    await expect(ui.getByRole('img', { name: 'Full-body photo · required' })).toBeVisible();

    await ui.getByLabel('Selfie · for skin analysis').setInputFiles(sample('selfie.png'));
    await expect(ui.getByRole('img', { name: 'Selfie · for skin analysis' })).toBeVisible();

    await enter.click();
    await expect(ui.getByText('A quick visual read of six skin concerns', { exact: false })).toBeVisible();
    await expect(ui.getByRole('img', { name: 'Your selfie' })).toBeVisible();
  });

  test('twin only, then add the selfie from the skin panel', async ({ anna }) => {
    await anna.open();
    const ui = anna.ui;
    await ui.getByRole('button', { name: 'Use my own photos' }).click();
    await ui.getByLabel('Full-body photo · required').setInputFiles(sample('person.png'));
    await ui.getByRole('button', { name: 'Enter the fitting room' }).click();

    const addSelfie = ui.getByLabel(/Add a bare-faced selfie/);
    await addSelfie.setInputFiles([]);
    await expect(ui.getByText('Add selfie', { exact: true })).toBeVisible();
    await addSelfie.setInputFiles(sample('selfie.png'));
    await expect(ui.getByRole('button', { name: 'Read my skin' })).toBeVisible();

    // Replace the twin from the studio (and a cancelled pick changes nothing).
    const twinInput = ui.locator('section', { hasText: 'Your twin' }).locator('input[type=file]');
    await twinInput.setInputFiles([]);
    await twinInput.setInputFiles(fixture('landscape.jpg'));
    await expect.poll(() => anna.host.count('upload.inline')).toBe(2);
  });

  test('demo persona shows a setting-up state while samples load', async ({ anna, page }) => {
    const hold = gate();
    await page.route('**/samples/person.png', async (route) => {
      await hold.wait();
      await route.fallback();
    });
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await expect(anna.ui.getByRole('button', { name: 'Setting up…' })).toBeDisabled();
    hold.open();
    await expect(anna.ui.getByText('Drop any screenshot')).toBeVisible();
  });
});

test.describe('skin today', () => {
  test('model failures map to friendly messages, then a read with brief', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const errorBox = ui.locator('section', { hasText: 'Skin today' }).locator('.text-brick');

    // No JSON at all, twice (retry once with a stricter reminder).
    host.llm.skin = () => llmText('Sorry, I cannot see a face.');
    await ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(errorBox).toContainText("The AI couldn't make sense of that one");
    expect(host.count('llm.complete')).toBe(2);

    // An opening brace but never a closing one.
    host.llm.skin = () => llmText('scores: { "redness": 70');
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText("The AI couldn't make sense of that one");

    // Too few concerns readable.
    host.llm.skin = () => llmText(JSON.stringify({ scores: { redness: 70, moisture: 'n/a' } }));
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText('Could not read the selfie');

    // Host errors with codes are not retried and read as plain language.
    const before = host.count('llm.complete');
    host.llm.skin = () => reject('APP_ERR_QUOTA_EXCEEDED', 'quota exceeded');
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText('You are out of Anna credits');
    expect(host.count('llm.complete')).toBe(before + 1);

    host.llm.skin = () => envelopeError('MODEL_NO_VISION');
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText('cannot read images');

    host.llm.skin = () => envelopeError(undefined);
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText('Anna request failed.');

    host.llm.skin = () => reject('APP_ERR_INTERNAL', 'Upstream hiccup');
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText('Upstream hiccup');

    host.llm.skin = () => reject(undefined, '');
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(errorBox).toContainText('Failed.');

    // A good read (bare reply, content as an array, odd skin type) — brief fails.
    host.llm.skin = () =>
      bare({ content: [{ type: 'text', text: JSON.stringify({ scores: { redness: 140, oiliness: -3, moisture: 60, radiance: 70.6 }, skin_type: 'oily-ish' }) }] });
    host.llm.brief = () => reject(undefined, 'network');
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(ui.getByText("Today's brief didn't come through.")).toBeVisible();
    await expect(ui.getByText('100', { exact: true })).toBeVisible(); // clamped
    await expect(ui.getByText(/^type ·/)).toHaveCount(0);

    // The brief alone can be retried.
    host.llm.brief = () => llmText(JSON.stringify(BRIEF));
    await ui.getByRole('button', { name: 'Retry' }).click();
    await expect(ui.getByText(BRIEF.headline, { exact: false })).toBeVisible();

    // Re-read: valid type, a brief whose swatches/care items are partly junk.
    host.llm.skin = (_a, attempt) =>
      attempt === 0 ? llmText('{"scores": oops}') : llmText(JSON.stringify({ scores: { redness: 64, oiliness: 71, moisture: 58 }, skin_type: 7 }));
    host.llm.brief = () =>
      llmText(
        JSON.stringify({
          headline: 'Even and bright',
          summary: 'Radiance leads today.',
          care_focus: [{ title: 'Hydrate', action: 'Sip water through the day.' }, { title: '', action: 'x' }, null],
          palette: { wear: [{ hex: '#7D93A8', name: 'Dusty blue' }, { hex: 'blue', name: 'Bad' }, { name: 'No hex' }, null], avoid: 'none' },
        }),
      );
    await ui.getByRole('button', { name: 'Re-read' }).click();
    await expect(ui.getByText('“Even and bright”')).toBeVisible();
    await expect(ui.getByText('Dusty blue')).toBeVisible();
    await expect(ui.getByText('Sip water through the day.')).toBeVisible();
    await expect(ui.getByText('Bad', { exact: true })).toHaveCount(0);
    await expect(ui.getByText('No hex')).toHaveCount(0);

    // A brief with no care items shows no care list.
    host.llm.brief = () => llmText(JSON.stringify({ ...BRIEF, headline: 'Nothing to fix', care_focus: 'none' }));
    await ui.getByRole('button', { name: 'Re-read' }).click();
    await expect(ui.getByText('“Nothing to fix”')).toBeVisible();
    await expect(ui.getByText(BRIEF.care_focus[0].action)).toHaveCount(0);

    // Brief replies that fail validation.
    for (const bad of ['null', JSON.stringify({ headline: 'x', summary: 'y', palette: { wear: [] } })]) {
      host.llm.brief = () => llmText(bad);
      await ui.getByRole('button', { name: 'Re-read' }).click();
      await expect(ui.getByText("Today's brief didn't come through.")).toBeVisible();
    }

    // Default read + full brief.
    host.llm.skin = () => llmText(JSON.stringify({ scores: { redness: 64, oiliness: 71, moisture: 58, radiance: 77, acne: 83, texture: 69 }, skin_type: 'Dry' }));
    host.llm.brief = () => llmText('```\n' + JSON.stringify(BRIEF) + '\n```');
    await ui.getByRole('button', { name: 'Re-read' }).click();
    await expect(ui.getByText('type · dry')).toBeVisible();
    await expect(ui.getByText(BRIEF.palette.guidance)).toBeVisible();
    await expect(ui.getByText('Reading your skin…')).toBeHidden();

    // Anna reads carry no masks, so concerns are plain rows, not dead buttons.
    await expect(ui.getByText('Redness', { exact: true })).toBeVisible();
    await expect(ui.getByRole('button', { name: /Redness/ })).toHaveCount(0);
    await expect(ui.getByRole('img', { name: 'Your selfie' })).toBeVisible();
  });
});

test.describe('screenshots → garments', () => {
  test('no garment, detection failures, junk boxes', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;

    host.llm.garments = () => llmText('[]');
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(ui.getByText('No clothing found in that image', { exact: false })).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();

    host.llm.garments = () => reject(undefined, '');
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(ui.getByText('Detection failed.')).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();

    host.llm.garments = () => llmText('Detected: [] (nothing wearable)');
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(ui.getByText('No clothing found in that image', { exact: false })).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();

    host.llm.garments = () => llmText('{"verdict": "not a list"}');
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(ui.getByText('No clothing found in that image', { exact: false })).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();

    // Only well-formed garments survive; a wrapped list is accepted.
    host.llm.garments = () =>
      llmText(
        'Found these: ' +
          JSON.stringify({
            garments: [
              null,
              { label: '', category: 'full_body', box_2d: [0, 0, 500, 500] },
              { label: 'Hat', category: 'accessory', box_2d: [0, 0, 500, 500] },
              { label: 'Short box', category: 'upper_body', box_2d: [0, 0, 500] },
              { label: 'No box', category: 'upper_body' },
              { label: 'Out of range', category: 'upper_body', box_2d: [0, 0, 1200, 500] },
              { label: 'Thin', category: 'upper_body', box_2d: [0, 0, 5, 500] },
              { label: 'Narrow', category: 'upper_body', box_2d: [0, 0, 500, 5] },
              { label: 'Wide-leg trousers', category: 'lower_body', box_2d: [500.4, 300, 990, 700.6], confidence: 'high' },
              { label: 'Linen shirt', category: 'upper_body', box_2d: [100, 300, 480, 700], description: 'White linen shirt.', confidence: 0.9 },
            ],
          }) +
          ' hope that helps',
      );
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(ui.getByText('Found 2 pieces')).toBeVisible();
    await ui.getByRole('button', { name: 'Wide-leg trousers' }).click();
    await expect(ui.getByRole('img', { name: 'You wearing Wide-leg trousers' })).toBeVisible();
    await expect(ui.getByText('lower body')).toBeVisible();
    const tryOnPrompt = host.calls.filter((c) => c.method === 'generate').at(-1)!.args.prompt as string;
    expect(tryOnPrompt).toContain('Replace only their bottoms');
    expect(tryOnPrompt).toContain('a garment: Wide-leg trousers.');
  });

  test('choose a file, drop one, paste one', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    host.llm.garments = () => llmText('[]');
    const chooser = ui.getByLabel('Choose an image');

    await chooser.setInputFiles([]);
    await chooser.setInputFiles(fixture('notes.txt'));
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    expect(host.count('llm.complete')).toBe(0);

    await chooser.setInputFiles(sample('garment_dress.png'));
    await expect(ui.getByText('No clothing found in that image', { exact: false })).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();

    // Drag over (highlight), leave, then drop a file.
    const zone = ui.locator('[class*="rounded-[26px]"]');
    const drag = (type: string) =>
      anna.evalApp(async (t) => {
        const blob = await (await fetch('./samples/garment_dress.png')).blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'look.png', { type: 'image/png' }));
        document.querySelector('[class*="rounded-[26px]"]')!.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, type);
    await drag('dragover');
    await expect(zone).toHaveClass(/ring-2/);
    await drag('dragleave');
    await expect(zone).not.toHaveClass(/ring-2/);
    await drag('dragover');
    await expect(zone).toHaveClass(/ring-2/);
    await drag('drop');
    await expect(zone).not.toHaveClass(/ring-2/);
    await expect(ui.getByText('No clothing found in that image', { exact: false })).toBeVisible();
    await ui.getByRole('button', { name: 'Start over' }).click();
    expect(host.count('llm.complete')).toBe(2);

    // Pastes that are not images, or typed into a field, are ignored.
    await anna.evalApp(async () => {
      window.dispatchEvent(new ClipboardEvent('paste'));
      const text = new DataTransfer();
      text.setData('text/plain', 'hello');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: text }));
      const blob = await (await fetch('./samples/garment_dress.png')).blob();
      const img = new DataTransfer();
      img.items.add(new File([blob], 'look.png', { type: 'image/png' }));
      document.querySelector('input[placeholder="or type your own…"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: img, bubbles: true }));
    }, null);
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    expect(host.count('llm.complete')).toBe(2);

    // A real image paste goes through.
    await anna.evalApp(async () => {
      const blob = await (await fetch('./samples/garment_dress.png')).blob();
      const img = new DataTransfer();
      img.items.add(new File([blob], 'look.png', { type: 'image/png' }));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: img }));
    }, null);
    await expect(ui.getByText('No clothing found in that image', { exact: false })).toBeVisible();
  });
});

test.describe('try-on', () => {
  test('a double tap on a garment starts one paid try-on', async ({ anna, host }) => {
    await enterStudio(anna);
    await anna.ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(anna.ui.getByText('Found 2 pieces')).toBeVisible();
    await anna.evalApp(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Sage slip dress')!;
      b.click();
      b.click();
    }, null);
    await expect(anna.ui.getByRole('img', { name: 'You wearing Sage slip dress' })).toBeVisible();
    expect(host.count('image.generate')).toBe(1);
  });

  test('first upload fails → try-on uploads the twin; expired key → re-upload', async ({ anna, host }) => {
    host.on('upload.inline', () => reject('APP_ERR_UPLOAD', 'upload down'));
    await enterStudio(anna);
    host.off('upload.inline');

    await tryOnBlazer(anna);
    expect(host.count('upload.inline')).toBe(3); // failed twin, twin again, garment
    expect(host.count('upload.confirm')).toBe(0);

    // Second try-on reuses the stored key; when it can't be refreshed, re-upload.
    host.on('upload.confirm', () => reject('not_found', 'gone'));
    await anna.ui.getByRole('button', { name: 'Try another' }).click();
    await tryOnBlazer(anna);
    expect(host.count('upload.confirm')).toBe(1);
    expect(host.count('upload.inline')).toBe(5);

    // And with a fresh key, no re-upload.
    host.off('upload.confirm');
    await anna.ui.getByRole('button', { name: 'Try another' }).click();
    await tryOnBlazer(anna);
    expect(host.count('upload.inline')).toBe(6);
    const gen = host.calls.filter((c) => c.method === 'generate').at(-1)!.args;
    expect(gen.reference_image_urls[0]).toContain('?fresh');
    expect(gen.aspect_ratio).toBe('3:4');
    expect(gen.size).toBe('768x1024');
  });

  test('image model failures', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const cases: [() => ReturnType<typeof ok>, string][] = [
      [() => ok({ images: [] }), 'The try-on came back empty'],
      [() => ok({}), 'The try-on came back empty'],
      [() => reject('APP_ERR_CONTENT_REJECTED', 'nsfw'), 'The image model declined this one'],
      [() => reject(undefined, ''), 'Try-on failed.'],
    ];
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    for (const [outcome, message] of cases) {
      host.on('image.generate', outcome);
      await ui.getByRole('button', { name: 'Blazer product shot' }).click();
      await expect(ui.getByText(message, { exact: false })).toBeVisible();
      await ui.getByRole('button', { name: 'Start over' }).click();
    }
  });

  test('tall phone-photo twin keeps its 9:16 frame', async ({ anna, host }) => {
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Use my own photos' }).click();
    await anna.ui.getByLabel('Full-body photo · required').setInputFiles(fixture('tall.jpg'));
    await anna.ui.getByRole('button', { name: 'Enter the fitting room' }).click();
    await tryOnBlazer(anna);
    const gen = host.calls.filter((c) => c.method === 'generate').at(-1)!.args;
    expect(gen.aspect_ratio).toBe('9:16');
    expect(gen.size).toBe('576x1024');
    // The whole photo is shown, never cropped to the stage's shape.
    await expect(anna.ui.getByRole('img', { name: 'You wearing Camel blazer' })).toHaveCSS('object-fit', 'contain');
    await expect(anna.ui.getByRole('img', { name: 'Your full-body photo' })).toHaveCSS('object-fit', 'contain');
  });

  test('landscape twin; result the App cannot read stays a URL', async ({ anna, host }) => {
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Use my own photos' }).click();
    await anna.ui.getByLabel('Full-body photo · required').setInputFiles(fixture('landscape.jpg'));
    await anna.ui.getByRole('button', { name: 'Enter the fitting room' }).click();

    // The CDN refuses both the App's fetch and the image itself (as when an
    // Anna image link has expired).
    host.cdnStatus = 403;
    anna.host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect.poll(() => host.count('image.generate')).toBe(1);
    const gen = host.calls.filter((c) => c.method === 'generate').at(-1)!.args;
    // A landscape twin still gets a full-length portrait try-on (a wide frame
    // made the model zoom in on the torso and drop the head and legs).
    expect(gen.aspect_ratio).toBe('3:4');
    expect(gen.size).toBe('768x1024');
    expect(gen.prompt).toContain('full-length, head-to-toe');
    expect(gen.prompt).toContain('Never crop, zoom in on, or cut off the head');
    // The verdict is asked about the remote URL; the lookbook keeps the URL.
    await expect(anna.ui.getByText('87/100')).toBeVisible();
    const verdictCall = host.calls.filter((c) => c.method === 'complete').at(-1)!.args;
    expect(verdictCall.messages[0].content[0]).toEqual({ type: 'image', url: 'https://cdn.test/result.jpg' });
    // An image that can't be shown says so, on the stage and in the lookbook.
    await expect(anna.ui.getByText("This look's image has expired")).toBeVisible();
    const book = anna.ui.getByRole('region', { name: 'Lookbook' });
    await expect(book.getByText('image expired')).toBeVisible();

    // A CDN reply that is not an image also falls back to the URL.
    host.cdnStatus = 200;
    host.cdnFile = fixture('broken.png');
    await anna.ui.getByRole('button', { name: 'Try another' }).click();
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText("This look's image has expired")).toBeVisible();
    await expect(book.getByText('image expired')).toHaveCount(2);
  });

  test('replacing the twin mid-flight keeps the newer photo and drops the old try-on', async ({ anna, host }) => {
    // Twin upload still running when the twin is replaced.
    const upload = gate();
    host.on('upload.inline', async () => {
      await upload.wait();
      return ok({ r2_key: 'r2/slow', download_url: 'https://cdn.test/u/slow.jpg' });
    });
    await enterStudio(anna);
    const twinInput = anna.ui.locator('section', { hasText: 'Your twin' }).locator('input[type=file]');
    await twinInput.setInputFiles(fixture('landscape.jpg'));
    await expect.poll(() => host.count('upload.inline')).toBe(2);
    upload.open();
    host.off('upload.inline');

    // Try-on still generating when the twin is replaced.
    const generating = gate();
    host.on('image.generate', async () => {
      await generating.wait();
      return ok({ images: [{ url: 'https://cdn.test/result.jpg' }] });
    });
    anna.host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText('tailoring camel blazer onto you…')).toBeVisible();
    await twinInput.setInputFiles(sample('person.png'));
    await expect.poll(() => host.count('upload.inline')).toBeGreaterThanOrEqual(4);
    // The try-on made for the old photo is dropped, not shown next to the new one.
    await expect(anna.ui.getByText('Drop any screenshot')).toBeVisible();
    generating.open();
    await expect.poll(() => host.count('image.generate')).toBe(1);
    await anna.page.waitForTimeout(300);
    await expect(anna.ui.getByRole('img', { name: 'You wearing Camel blazer' })).toHaveCount(0);
    await expect(anna.ui.getByText('Drop any screenshot')).toBeVisible();
  });

  test('Start fresh while a screenshot is being read', async ({ anna, host }) => {
    await enterStudio(anna);
    const detecting = gate();
    host.llm.garments = async () => {
      await detecting.wait();
      return llmText(JSON.stringify(GARMENT_ONE));
    };
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText('reading the look…')).toBeVisible();
    await anna.ui.getByRole('button', { name: 'Start fresh' }).click();
    await anna.ui.getByRole('button', { name: /Click again to clear/ }).click();
    await expect(anna.ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
    detecting.open();
    await expect.poll(() => host.count('llm.complete')).toBe(1);
    // No twin any more: nothing is generated or billed.
    await anna.page.waitForTimeout(300);
    expect(host.count('image.generate')).toBe(0);
  });
});

test.describe('stylist verdict + lookbook', () => {
  test('verdict kinds, retries, occasions and the lookbook', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    await expect(ui.getByText('judge the look for', { exact: false })).toContainText('a regular day out.');

    // Verdict fails (twice: uncoded error is retried) → kept in the lookbook without a verdict.
    host.llm.verdict = () => reject(undefined, 'model busy');
    await tryOnBlazer(anna);
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
    const book = ui.getByRole('region', { name: 'Lookbook' });
    await expect(book.getByRole('button')).toHaveCount(1);

    // Ask again → a "maybe" with no pairing, unknown score, no harmony note.
    host.llm.verdict = () => llmText(JSON.stringify({ verdict: 'maybe', score: 'high', headline: 'Close, but not quite.', reasons: 'n/a', pairing: [] }));
    await ui.getByRole('button', { name: 'Ask again' }).click();
    await expect(ui.locator('p', { hasText: /≈\s+Maybe/ })).toBeVisible();
    await expect(ui.getByText('50/100')).toBeVisible();
    await expect(ui.getByText('complete it')).toHaveCount(0);
    await expect(book.getByRole('button')).toHaveCount(1); // same look → entry updated
    await expect(book.getByText('≈')).toBeVisible();

    // Occasion change re-judges; a malformed verdict is an error.
    host.llm.verdict = () => llmText(JSON.stringify({ verdict: 'love it', headline: 'x' }));
    await ui.getByRole('button', { name: 'the office' }).click();
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();

    host.llm.verdict = () => llmText(JSON.stringify({ ...VERDICT, verdict: 'skip', score: 140 }));
    await ui.getByPlaceholder('or type your own…').fill('a gallery opening');
    await ui.getByRole('button', { name: 'Set', exact: true }).click();
    await expect(ui.locator('p', { hasText: /✕\s+Skip it/ })).toBeVisible();
    await expect(ui.getByText('100/100')).toBeVisible();
    await expect(ui.getByText('stylist verdict · a gallery opening')).toBeVisible();
    const verdictPrompt = host.calls.filter((c) => c.method === 'complete').at(-1)!.args.messages[0].content[1].text as string;
    expect(verdictPrompt).toContain('No skin analysis available');

    // Blank custom occasion does nothing.
    await ui.getByPlaceholder('or type your own…').fill('   ');
    await ui.getByRole('button', { name: 'Set', exact: true }).click();
    await expect(ui.getByText('stylist verdict · a gallery opening')).toBeVisible();

    // While a verdict is running, an occasion change asks again; only the
    // newest answer shows, under the occasion it was written for.
    const judging = gate();
    host.llm.verdict = async () => {
      await judging.wait();
      return llmText(JSON.stringify(VERDICT));
    };
    const calls = host.count('llm.complete');
    await ui.getByRole('button', { name: 'a first date' }).click();
    await expect(ui.getByText('Looking you over…')).toBeVisible();
    await ui.getByRole('button', { name: 'a night out' }).click();
    await ui.getByPlaceholder('or type your own…').fill('brunch');
    await ui.getByRole('button', { name: 'Set', exact: true }).click();
    await expect.poll(() => host.count('llm.complete')).toBe(calls + 3);
    judging.open();
    await expect(ui.locator('p', { hasText: /✓\s+Wear it/ })).toBeVisible();
    await expect(ui.getByText('stylist verdict · brunch')).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(1);

    // Slider: drag, hover without button, keyboard range.
    const mirror = ui.getByRole('img', { name: 'You wearing Camel blazer' });
    const box = (await mirror.boundingBox())!;
    await anna.page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await anna.page.mouse.down();
    await anna.page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await anna.page.mouse.up();
    await anna.page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await ui.getByLabel('Reveal the try-on result').fill('60');

    // Second look → two lookbook entries; open the first (verdict) and the older.
    await ui.getByRole('button', { name: 'Try another' }).click();
    await expect(ui.getByText('judge the look for', { exact: false })).toContainText('brunch');
    host.llm.garments = () => llmText(JSON.stringify(GARMENTS_TWO));
    host.llm.verdict = () => reject(undefined, 'busy');
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await ui.getByRole('button', { name: 'Sage slip dress' }).click();
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(2);

    // Re-judging a look whose verdict failed updates its entry, never duplicates it.
    await ui.getByRole('button', { name: 'the office' }).click();
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(2);

    // Reopen the blazer look: its saved verdict shows under the occasion it was
    // written for (brunch), not the one selected now (the office).
    await book.getByRole('button', { name: /Camel blazer/ }).click();
    await expect(ui.locator('p', { hasText: /✓\s+Wear it/ })).toBeVisible();
    await expect(ui.getByText('stylist verdict · brunch')).toBeVisible();

    // Reopen the dress look: no verdict saved → "Ask again" judges it from the
    // saved image and updates the same entry.
    await book.getByRole('button', { name: /Sage slip dress/ }).click();
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
    host.llm.verdict = () => llmText(JSON.stringify(VERDICT));
    await ui.getByRole('button', { name: 'Ask again' }).click();
    await expect(ui.getByText('stylist verdict · the office')).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(2);
    await expect(book.getByText('✓')).toHaveCount(2);

    // A reopened look can be re-judged for another occasion too.
    const before = host.count('llm.complete');
    await ui.getByRole('button', { name: 'a night out' }).click();
    await expect(ui.getByText('stylist verdict · a night out')).toBeVisible();
    expect(host.count('llm.complete')).toBe(before + 1);
    await expect(book.getByRole('button')).toHaveCount(2);
  });

  test('a newer request supersedes an older one (success and failure)', async ({ anna, host }) => {
    await enterStudio(anna);
    const first = gate();
    const second = gate();
    let n = 0;
    host.llm.verdict = async () => {
      n++;
      if (n === 1) {
        await first.wait();
        return llmText(JSON.stringify({ ...VERDICT, headline: 'Stale answer' }));
      }
      if (n === 2) {
        await second.wait();
        return reject('APP_ERR_STALE', 'stale failure');
      }
      return llmText(JSON.stringify(VERDICT));
    };
    anna.host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText('Looking you over…')).toBeVisible();
    // Replace the look with a new try-on while #1 is pending → #2 pending → #3.
    await anna.ui.getByRole('button', { name: 'Try another' }).click();
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect.poll(() => n).toBe(2);
    await anna.ui.getByRole('button', { name: 'Try another' }).click();
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText(VERDICT.headline)).toBeVisible();
    first.open();
    second.open();
    await anna.page.waitForTimeout(300);
    await expect(anna.ui.getByText(VERDICT.headline)).toBeVisible();
    await expect(anna.ui.getByText('Stale answer')).toHaveCount(0);
  });

  test('verdict prompt uses the skin brief when there is one', async ({ anna, host }) => {
    await enterStudio(anna);
    await anna.ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(anna.ui.getByText(`“${BRIEF.headline}”`)).toBeVisible();
    await expect(anna.ui.getByText('— against today’s skin brief.', { exact: false })).toBeVisible();
    await tryOnBlazer(anna);
    await expect(anna.ui.getByText('Strappy sandals')).toBeVisible();
    const prompt = host.calls.filter((c) => c.method === 'complete').at(-1)!.args.messages[0].content[1].text as string;
    expect(prompt).toContain("Today's skin brief for this user");
  });
});

/** Make data: image decoding slow, as on a slow device saving lookbook images. */
async function slowDecoding(anna: AnnaApp) {
  await anna.ui.locator('body').evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get: desc.get,
      set(v: string) {
        if (String(v).startsWith('data:')) setTimeout(() => desc.set!.call(this, v), 800);
        else desc.set!.call(this, v);
      },
    });
  });
}

// What a reviewer does with their own files and an impatient mouse.
test.describe('review hardening', () => {
  test('unreadable files and failed loads explain themselves', async ({ anna, page }) => {
    await anna.open();
    const ui = anna.ui;
    const alert = ui.getByRole('alert');

    // Demo photos that fail to load.
    await page.route('**/samples/person.png', (r) => r.abort());
    await ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await expect(alert).toContainText('The demo photos could not be loaded');
    await page.unroute('**/samples/person.png');

    // A corrupt photo in the welcome slot; dismissed by hand.
    await ui.getByRole('button', { name: 'Use my own photos' }).click();
    await ui.getByLabel('Full-body photo · required').setInputFiles(fixture('broken.png'));
    await expect(alert).toContainText("couldn't be opened as a photo");
    await expect(ui.getByRole('img', { name: 'Full-body photo · required' })).toHaveCount(0);
    await ui.getByRole('button', { name: 'Dismiss' }).click();
    await expect(alert).toHaveCount(0);

    // A transparent PNG lands on white, not black.
    await ui.getByLabel('Full-body photo · required').setInputFiles(fixture('transparent.png'));
    const corner = await ui.getByRole('img', { name: 'Full-body photo · required' }).evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(2, 2, 1, 1).data);
    });
    expect(corner.slice(0, 3).every((v) => v > 245)).toBe(true);
    await ui.getByLabel('Full-body photo · required').setInputFiles(sample('person.png'));
    await ui.getByRole('button', { name: 'Enter the fitting room' }).click();
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();

    // A text file as a screenshot; a sample screenshot that fails to load.
    await ui.locator('input[type=file][accept="image/*"]').setInputFiles(fixture('notes.txt'));
    await expect(alert).toContainText("couldn't be opened as a photo");
    await page.route('**/samples/garment_jacket.png', (r) => r.abort());
    await ui.getByRole('button', { name: 'Dismiss' }).click();
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(alert).toContainText("couldn't be opened as a photo");
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();

    // A corrupt replacement twin leaves the current one in place.
    const twinInput = ui.locator('section', { hasText: 'Your twin' }).locator('input[type=file]');
    await twinInput.setInputFiles(fixture('broken.png'));
    await expect(ui.getByRole('img', { name: 'Your full-body photo' })).toBeVisible();
  });

  test('notices dismiss themselves', async ({ anna, page }) => {
    await page.clock.install();
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Use my own photos' }).click();
    await anna.ui.getByLabel('Full-body photo · required').setInputFiles(fixture('broken.png'));
    await expect(anna.ui.getByRole('alert')).toBeVisible();
    await page.clock.fastForward(9000);
    await expect(anna.ui.getByRole('alert')).toHaveCount(0);
  });

  test('the selfie can be replaced on its own', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    await ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(ui.getByText('Redness', { exact: true })).toBeVisible();
    const newSelfie = ui.locator('label', { hasText: 'New selfie' }).locator('input');
    // A bad file keeps the reading; a good one starts a fresh read.
    await newSelfie.setInputFiles(fixture('broken.png'));
    await expect(ui.getByRole('alert')).toBeVisible();
    await expect(ui.getByText('Redness', { exact: true })).toBeVisible();
    await newSelfie.setInputFiles(sample('person.png'));
    await expect(ui.getByRole('button', { name: 'Read my skin' })).toBeVisible();
    await expect(ui.getByRole('img', { name: 'Your full-body photo' })).toBeVisible(); // twin kept
    expect(host.count('image.generate')).toBe(0);
  });

  test('picking among overlapping pieces, cancelling, and backing out', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const OUTFIT = [
      { label: 'Full outfit', category: 'full_body', box_2d: [60, 330, 900, 690], description: 'outfit', confidence: 0.8 },
      { label: 'Rust knit sweater', category: 'upper_body', box_2d: [60, 330, 420, 690], description: 'sweater', confidence: 0.95 },
    ];
    host.llm.garments = () => llmText(JSON.stringify(OUTFIT));

    // Back out of the pick list.
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    const chip = ui.getByRole('button', { name: 'Rust knit sweater' });
    await chip.hover();
    await chip.focus();
    await chip.blur();
    await ui.getByRole('button', { name: 'Full outfit' }).hover();
    await ui.getByRole('button', { name: 'Choose another screenshot' }).click();
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();

    // The sweater box sits on top of the outfit box, so a click on it picks the sweater.
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    const box = ui.locator('button[title="Rust knit sweater"]');
    await box.hover();
    await ui.locator('button[title="Full outfit"]').hover({ position: { x: 10, y: 300 } });
    const generating = gate();
    host.on('image.generate', async () => {
      await generating.wait();
      return ok({ images: [{ url: 'https://cdn.test/result.jpg' }] });
    });
    await box.click();
    await expect(ui.getByText('tailoring rust knit sweater onto you…')).toBeInViewport();

    // Cancel while generating: the late result is dropped.
    await ui.getByRole('button', { name: 'Cancel' }).click();
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    generating.open();
    await expect.poll(() => host.count('image.generate')).toBe(1);
    await anna.page.waitForTimeout(300);
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    host.off('image.generate');

    // Cancel while the screenshot is being read: a late failure is dropped too.
    const reading = gate();
    host.llm.garments = async () => {
      await reading.wait();
      return reject('APP_PROVIDER_ERROR', 'late failure');
    };
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(ui.getByText('reading the look…')).toBeInViewport();
    await ui.getByRole('button', { name: 'Cancel' }).click();
    reading.open();
    await anna.page.waitForTimeout(300);
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    await expect(ui.getByText("That one didn't work")).toHaveCount(0);
    expect(host.count('image.generate')).toBe(1);
  });

  test('a piece that cannot be cut out says so', async ({ anna, host }) => {
    await enterStudio(anna);
    host.llm.garments = () => llmText(JSON.stringify(GARMENTS_TWO));
    await anna.ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(anna.ui.getByRole('button', { name: 'Sage slip dress' })).toBeVisible();
    await anna.ui.locator('body').evaluate(() => {
      HTMLCanvasElement.prototype.toDataURL = () => {
        throw new Error('canvas too large');
      };
    });
    await anna.ui.getByRole('button', { name: 'Sage slip dress' }).click();
    await expect(anna.ui.getByText('Could not cut that piece out of the screenshot')).toBeVisible();
    expect(host.count('image.generate')).toBe(0);
  });

  test('a failed re-judge keeps the verdict the look already had', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const book = ui.getByRole('region', { name: 'Lookbook' });
    await tryOnBlazer(anna);
    await expect(ui.getByText('87/100')).toBeVisible();
    await expect(book.getByText('✓')).toHaveCount(1);

    host.llm.verdict = () => reject(undefined, 'busy');
    await ui.getByRole('button', { name: 'the office' }).click();
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(1);
    await expect(book.getByText('✓')).toHaveCount(1);

    // Picking a preset occasion clears a half-typed custom one.
    const custom = ui.getByPlaceholder('or type your own…');
    await custom.fill('brunch');
    await ui.getByRole('button', { name: 'a night out' }).click();
    await expect(custom).toHaveValue('');

    await ui.getByRole('button', { name: 'Try another' }).click();
    await book.getByRole('button', { name: /Camel blazer/ }).click();
    await expect(ui.getByText('87/100')).toBeVisible();
    await expect(ui.getByText('stylist verdict · a regular day out')).toBeVisible();
    // The reopened look keeps its garment category.
    await expect(ui.getByText('upper body', { exact: true })).toBeVisible();
  });

  test('verdicts racing while the look is saved: the newest wins, one entry', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const book = ui.getByRole('region', { name: 'Lookbook' });
    const judging = gate();
    host.llm.verdict = async () => {
      await judging.wait();
      return llmText(JSON.stringify(VERDICT));
    };
    await tryOnBlazer(anna);
    await expect(ui.getByText('Looking you over…')).toBeVisible();
    // Slow image decoding (a slow device re-encoding the lookbook images).
    await slowDecoding(anna);
    judging.open();
    await expect(ui.getByText('87/100')).toBeVisible();
    // A second verdict while the first is still saving the look.
    host.llm.verdict = () => llmText(JSON.stringify({ ...VERDICT, verdict: 'skip', score: 20 }));
    await ui.getByRole('button', { name: 'the office' }).click();
    await expect(ui.locator('p', { hasText: /✕\s+Skip it/ })).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(1);
    await expect(book.getByText('✕')).toHaveCount(1);
    await expect(book.getByText('✓')).toHaveCount(0);
  });

  test("a new selfie drops the old selfie's brief", async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const old = gate();
    host.llm.brief = async () => {
      await old.wait();
      return llmText(JSON.stringify({ ...BRIEF, headline: 'OLD SELFIE BRIEF' }));
    };
    await ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(ui.getByText("Writing today's brief…")).toBeVisible();
    await ui.locator('label', { hasText: 'New selfie' }).locator('input').setInputFiles(sample('selfie.png'));
    host.llm.brief = () => llmText(JSON.stringify({ ...BRIEF, headline: 'NEW SELFIE BRIEF' }));
    await ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(ui.getByText('NEW SELFIE BRIEF', { exact: false })).toBeVisible();
    old.open();
    await anna.page.waitForTimeout(300);
    await expect(ui.getByText('OLD SELFIE BRIEF', { exact: false })).toHaveCount(0);
    await expect(ui.getByText('NEW SELFIE BRIEF', { exact: false })).toBeVisible();
  });

  test("Anna's smallest window (900x620): primary actions stay on screen", async ({ anna, host, page }) => {
    await anna.open();
    await page.locator('#app').evaluate((f: HTMLIFrameElement) => {
      f.style.width = '900px';
      f.style.height = '620px';
    });
    const ui = anna.ui;
    await ui.getByRole('button', { name: 'Use my own photos' }).click();
    await expect(ui.getByRole('button', { name: 'Enter the fitting room' })).toBeInViewport();
    await expect(ui.getByRole('button', { name: 'Back' })).toBeInViewport();
    await ui.getByRole('button', { name: 'Back' }).click();
    await ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    const generating = gate();
    host.on('image.generate', async () => {
      await generating.wait();
      return ok({ images: [{ url: 'https://cdn.test/result.jpg' }] });
    });
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(ui.getByText('tailoring camel blazer onto you…')).toBeInViewport();
    await expect(ui.getByRole('button', { name: 'Cancel' })).toBeInViewport();
    generating.open();
    await expect(ui.getByRole('button', { name: 'Try another' })).toBeInViewport();
  });

  test('a failing re-judge while the look is still being saved keeps the good verdict', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const book = ui.getByRole('region', { name: 'Lookbook' });
    const judging = gate();
    host.llm.verdict = async () => {
      await judging.wait();
      return llmText(JSON.stringify(VERDICT));
    };
    await tryOnBlazer(anna);
    await slowDecoding(anna);
    judging.open();
    await expect(ui.getByText('87/100')).toBeVisible();
    host.llm.verdict = () => reject(undefined, 'busy');
    await ui.getByRole('button', { name: 'the office' }).click();
    await expect(ui.getByText('The stylist stepped away.')).toBeVisible();
    await expect(book.getByText('✓')).toHaveCount(1);
    await anna.page.waitForTimeout(1200);
    await expect(book.getByRole('button')).toHaveCount(1);
    await expect(book.getByText('✓')).toHaveCount(1);
  });

  test('Start fresh while a verdict is failing: nothing comes back', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const judging = gate();
    host.llm.verdict = async () => {
      await judging.wait();
      return reject('APP_PROVIDER_ERROR', 'late failure');
    };
    await tryOnBlazer(anna);
    await expect(ui.getByText('Looking you over…')).toBeVisible();
    await ui.getByRole('button', { name: 'Start fresh' }).click();
    await ui.getByRole('button', { name: /Click again to clear/ }).click();
    await expect(ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
    judging.open();
    await anna.page.waitForTimeout(300);
    await expect(ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
    expect(host.imageKeys().length).toBe(0);
  });

  test('a screenshot still loading when Start fresh is clicked is dropped', async ({ anna, host, page }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const held = gate();
    await page.route('**/samples/garment_jacket.png', async (r) => {
      await held.wait();
      await r.fallback();
    });
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await ui.getByRole('button', { name: 'Start fresh' }).click();
    await ui.getByRole('button', { name: /Click again to clear/ }).click();
    await expect(ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
    const before = host.count('llm.complete');
    held.open();
    await page.waitForTimeout(500);
    expect(host.count('llm.complete')).toBe(before);
    await expect(ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
  });

  test('double-clicking Enter uploads the photo once', async ({ anna, host }) => {
    await anna.open();
    const ui = anna.ui;
    await ui.getByRole('button', { name: 'Use my own photos' }).click();
    await ui.getByLabel('Full-body photo · required').setInputFiles(sample('person.png'));
    await ui.getByRole('button', { name: 'Enter the fitting room' }).dblclick();
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    await anna.page.waitForTimeout(300);
    expect(host.count('upload.inline')).toBe(1);
  });

  test('Anna errors a reviewer can hit read as plain sentences', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    const cases: [string | undefined, string, string][] = [
      ['APP_RATE_LIMITED', 'Too many image requests', 'Anna is busy right now'],
      ['APP_ERR_NOT_GRANTED', 'This app is not allowed to generate images', 'Anna did not allow this request'],
      ['IMAGE_SIZE_UNSUPPORTED', 'size 688x1024 is not supported', "The image model couldn't make this one"],
      [undefined, 'RPC image.generate timed out after 180000ms (pass { timeoutMs } as the 2nd arg to override)', 'Anna took too long to answer'],
    ];
    for (const [code, raw, plain] of cases) {
      host.on('image.generate', () => reject(code, raw));
      await ui.getByRole('button', { name: 'Blazer product shot' }).click();
      await expect(ui.getByText(plain, { exact: false })).toBeVisible();
      await expect(ui.getByText(raw)).toHaveCount(0);
      await ui.getByRole('button', { name: 'Start over' }).click();
    }
    host.off('image.generate');

    // A detection timeout is not retried (a retry would be billed again).
    const before = host.count('llm.complete');
    host.llm.garments = () => reject(undefined, 'RPC llm.complete timed out after 90000ms (pass { timeoutMs } as the 2nd arg to override)');
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(ui.getByText('Anna took too long to answer', { exact: false })).toBeVisible();
    expect(host.count('llm.complete')).toBe(before + 1);
    await ui.getByRole('button', { name: 'Start over' }).click();

    // Out of credits on the verdict and on the skin brief says so.
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    host.llm.verdict = () => reject('APP_ERR_QUOTA_EXCEEDED', 'quota exceeded');
    await tryOnBlazer(anna);
    await expect(ui.getByText('You are out of Anna credits', { exact: false })).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Ask again' })).toBeVisible();
    host.llm.brief = () => reject('APP_ERR_QUOTA_EXCEEDED', 'quota exceeded');
    await ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(ui.locator('section', { hasText: 'Skin today' }).getByText('You are out of Anna credits', { exact: false })).toBeVisible();
  });

  test('a look made from an earlier full-body photo is not compared with the new one', async ({ anna, host }) => {
    await enterStudio(anna);
    const ui = anna.ui;
    const book = ui.getByRole('region', { name: 'Lookbook' });
    await tryOnBlazer(anna);
    await expect(ui.getByText('87/100')).toBeVisible();
    // Same photo: before/after compare.
    await ui.getByRole('button', { name: 'Try another' }).click();
    await book.getByRole('button', { name: /Camel blazer/ }).click();
    await expect(ui.getByLabel('Reveal the try-on result')).toHaveCount(1);

    // A look whose image can't load any more (CDN refuses it) on a new photo.
    host.cdnStatus = 403;
    await ui.getByRole('button', { name: 'Try another' }).click();
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(ui.getByText("This look's image has expired")).toBeVisible();
    await expect(book.getByRole('button')).toHaveCount(2);

    // One more unloadable look, under another link.
    host.on('image.generate', () => ok({ images: [{ url: 'https://cdn.test/other.jpg' }] }));
    await ui.getByRole('button', { name: 'Try another' }).click();
    await ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(book.getByRole('button')).toHaveCount(3);
    host.off('image.generate');

    // New full-body photo: older looks show alone, labelled.
    await ui.locator('section', { hasText: 'Your twin' }).locator('input[type=file]').setInputFiles(fixture('landscape.jpg'));
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    const looks = book.getByRole('button', { name: /Camel blazer/ });
    await looks.last().click();
    await expect(ui.getByText('from an earlier photo')).toBeVisible();
    await expect(ui.getByLabel('Reveal the try-on result')).toHaveCount(0);
    await expect(ui.getByRole('img', { name: 'You wearing Camel blazer' })).toBeVisible();
    // An earlier-photo look whose image no longer loads says so.
    await looks.nth(1).click();
    await expect(ui.getByText("This look's image has expired")).toBeVisible();
  });

  test('while the demo loads, "Use my own photos" waits', async ({ anna, page }) => {
    await anna.open();
    const ui = anna.ui;
    const held = gate();
    await page.route('**/samples/person.png', async (r) => {
      await held.wait();
      await r.fallback();
    });
    await ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await expect(ui.getByRole('button', { name: 'Setting up…' })).toBeDisabled();
    await expect(ui.getByRole('button', { name: 'Use my own photos' })).toBeDisabled();
    held.open();
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
  });
});
