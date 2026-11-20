// The Anna review path: a fresh install, the full flow, and "Start fresh".
// Also run against the real submission bundle (`npm run test:e2e:release`).

import { GARMENTS_TWO, GARMENT_ONE, VERDICT, expect, gate, llmText, ok, reject, test, type AnnaApp } from './support/harness';

test.describe('Anna edition · fresh install, full flow', () => {
  test('demo persona → skin read → try-on → verdict → lookbook → Start fresh → start again', async ({ anna, host }) => {
    await anna.open();
    const ui = anna.ui;

    // Fresh install: welcome screen, nothing stored yet.
    await expect(ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
    await expect(ui.getByText('Powered by Anna AI')).toBeVisible();

    await ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await expect(ui.getByText('Drop any screenshot')).toBeVisible();
    await expect(ui.getByText('anna ai skin read, try-on + styling · not medical advice')).toBeVisible();

    // Skin read + daily brief on the Anna vision model.
    await ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(ui.getByText('type · combination')).toBeVisible();
    await expect(ui.getByText('“Calm, a little thirsty today”')).toBeVisible();
    await expect(ui.getByText('Brick red')).toBeVisible();

    // Screenshot with two garments → pick one → try-on → verdict.
    await ui.getByRole('button', { name: 'Street-style photo' }).click();
    await expect(ui.getByText(`Found ${GARMENTS_TWO.length} pieces`)).toBeVisible();
    await ui.getByRole('button', { name: 'Sage slip dress' }).click();
    await expect(ui.getByRole('img', { name: 'You wearing Sage slip dress' })).toBeVisible();
    await expect(ui.getByText('Wear it', { exact: false }).first()).toBeVisible();
    await expect(ui.getByText('87/100')).toBeVisible();
    await expect(ui.getByRole('region', { name: 'Lookbook' })).toBeVisible();
    expect(host.count('image.generate')).toBe(1);

    // Let the debounced save land, then make sure something is stored.
    await expect.poll(() => host.storage.has('state/anywear')).toBe(true);
    await expect.poll(() => host.imageKeys().length).toBeGreaterThan(0);

    // ---- The reviewer's bug: "Start fresh" must work inside the sandbox. ----
    const startFresh = ui.getByRole('button', { name: 'Start fresh' });
    await startFresh.click();
    // First click arms an in-page confirmation (no native dialog)…
    const confirmClear = ui.getByRole('button', { name: /Click again to clear/ });
    await expect(confirmClear).toBeVisible();
    await expect(ui.getByText('Drop any screenshot')).toBeHidden(); // still in the studio, look still shown
    // …the second click clears everything and returns to the welcome screen.
    await confirmClear.click();
    await expect(ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();

    // The cleared state is what gets saved, and stored photos are collected.
    await expect
      .poll(() => (host.storage.get('state/anywear') as { state?: { twinPhoto: unknown } } | undefined)?.state?.twinPhoto)
      .toBeNull();
    await expect.poll(() => host.imageKeys().length).toBe(0);

    // Reopening the App window stays on a clean slate.
    await anna.reopen();
    await expect(anna.ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();

    // And a new session works end to end from there.
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText('Found 2 pieces')).toBeVisible();
  });

  test('an armed Start fresh disarms itself if not confirmed', async ({ anna }) => {
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await anna.ui.getByRole('button', { name: 'Start fresh' }).click();
    await expect(anna.ui.getByRole('button', { name: /Click again to clear/ })).toBeVisible();
    // Untouched for > 4 s → back to the plain button, nothing cleared.
    await expect(anna.ui.getByRole('button', { name: 'Start fresh' })).toBeVisible({ timeout: 6_000 });
    await expect(anna.ui.getByRole('img', { name: 'Your full-body photo' })).toBeVisible();
  });

  // Found by independent QA on the real Anna harness: work still running when
  // the user starts fresh must not write the old session back.
  async function startFresh(anna: AnnaApp) {
    await anna.ui.getByRole('button', { name: 'Start fresh' }).click();
    await anna.ui.getByRole('button', { name: /Click again to clear/ }).click();
    await expect(anna.ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
  }
  const savedLookbook = (anna: AnnaApp) => (anna.host.storage.get('state/anywear') as any)?.state?.lookbook?.length;

  test('Start fresh while a try-on is being generated', async ({ anna, host }) => {
    const generating = gate();
    host.on('image.generate', async () => {
      await generating.wait();
      return ok({ images: [{ url: 'https://cdn.test/result.jpg' }] });
    });
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText('tailoring camel blazer onto you…')).toBeVisible();
    await startFresh(anna);

    generating.open(); // the paid try-on comes back after the reset
    await expect.poll(() => host.count('image.generate')).toBe(1);
    await anna.page.waitForTimeout(1500); // past the save debounce
    expect(host.count('llm.complete')).toBe(1); // detection only: no verdict asked
    expect(savedLookbook(anna)).toBe(0);

    await anna.reopen();
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await expect(anna.ui.getByText('Drop any screenshot')).toBeVisible();
    await expect(anna.ui.getByRole('region', { name: 'Lookbook' })).toHaveCount(0);
  });

  test('Start fresh while the stylist is judging', async ({ anna, host }) => {
    const judging = gate();
    host.llm.verdict = async () => {
      await judging.wait();
      return llmText(JSON.stringify(VERDICT));
    };
    host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await anna.ui.getByRole('button', { name: 'Blazer product shot' }).click();
    await expect(anna.ui.getByText('Looking you over…')).toBeVisible();
    await startFresh(anna);
    judging.open();
    await anna.page.waitForTimeout(1500);
    expect(savedLookbook(anna)).toBe(0);
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await expect(anna.ui.getByRole('region', { name: 'Lookbook' })).toHaveCount(0);
  });

  test('a skin read that fails after Start fresh leaves the new session alone', async ({ anna, host }) => {
    const reading = gate();
    host.llm.skin = async () => {
      await reading.wait();
      return reject('APP_ERR_INTERNAL', 'late failure');
    };
    await anna.open();
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    await anna.ui.getByRole('button', { name: 'Read my skin' }).click();
    await expect(anna.ui.getByText('Reading your skin…')).toBeVisible();
    await startFresh(anna);
    await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
    reading.open();
    await expect.poll(() => host.count('llm.complete')).toBe(1);
    await anna.page.waitForTimeout(300);
    await expect(anna.ui.getByRole('button', { name: 'Read my skin' })).toBeVisible();
    await expect(anna.ui.getByText('late failure')).toHaveCount(0);
  });
});
