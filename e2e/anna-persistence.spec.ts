// Anna edition: saving to Anna Persistent Storage, restoring on reopen, and
// every way the host's storage can answer or fail.

import { BRIEF, GARMENT_ONE, bare, envelopeError, expect, gate, llmText, ok, reject, test, type AnnaApp, type RpcOutcome } from './support/harness';

async function enterStudio(anna: AnnaApp) {
  await anna.open();
  await anna.ui.getByRole('button', { name: 'Step in with the demo persona' }).click();
  await expect(anna.ui.getByText('Drop any screenshot')).toBeVisible();
}

/** Ask the App to save now, as when its window is hidden. */
async function hide(anna: AnnaApp) {
  await anna.evalApp(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, null);
}

function warnings(anna: AnnaApp) {
  const out: string[] = [];
  anna.page.on('console', (m) => {
    if (m.type() === 'warning') out.push(m.text());
  });
  return out;
}

test('a saved fitting room comes back on reopen, images chunked and not re-uploaded', async ({ anna, host }) => {
  await enterStudio(anna);
  const ui = anna.ui;
  await ui.getByRole('button', { name: 'Read my skin' }).click();
  await expect(ui.getByText('type · combination')).toBeVisible();
  host.llm.garments = () => llmText(JSON.stringify(GARMENT_ONE));
  await ui.getByRole('button', { name: 'Blazer product shot' }).click();
  await expect(ui.getByText('87/100')).toBeVisible();
  await ui.getByRole('button', { name: 'the office' }).click();
  await expect(ui.locator('p', { hasText: /✓\s+Wear it/ })).toBeVisible();

  // Big images are split into chunks behind a manifest.
  await expect.poll(() => [...host.storage.keys()].some((k) => /^img\/.+\.\d+$/.test(k))).toBe(true);
  await expect.poll(() => (host.storage.get('state/anywear') as any)?.state?.occasion).toBe('the office');

  // Window hidden while nothing is pending, shown again: nothing to do.
  await hide(anna);
  await anna.evalApp(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, null);

  // Reopen: twin, skin read, lookbook and occasion are restored.
  await anna.reopen();
  await expect(ui.getByRole('img', { name: 'Your full-body photo' })).toBeVisible();
  await expect(ui.getByText('type · combination')).toBeVisible();
  await expect(ui.getByRole('region', { name: 'Lookbook' }).getByRole('button')).toHaveCount(1);
  await expect(ui.getByRole('button', { name: 'the office' })).toHaveAttribute('aria-pressed', 'true');

  // Saving again does not re-upload images that are already stored.
  const imageWrites = () => host.calls.filter((c) => c.method === 'set' && String(c.args.key).startsWith('img/')).length;
  const before = imageWrites();
  await ui.getByRole('button', { name: 'a night out' }).click();
  await hide(anna);
  await expect.poll(() => (host.storage.get('state/anywear') as any)?.state?.occasion).toBe('a night out');
  expect(imageWrites()).toBe(before);
});

test('a pending save is flushed when the window closes', async ({ anna, host }) => {
  await enterStudio(anna);
  await expect.poll(() => host.storage.has('state/anywear')).toBe(true);
  await anna.ui.getByRole('button', { name: 'a wedding guest look' }).click();
  await anna.ui.getByRole('button', { name: 'a first date' }).click(); // debounced: one write
  await anna.reopen(); // pagehide flushes immediately
  await expect.poll(() => (host.storage.get('state/anywear') as any)?.state?.occasion).toBe('a first date');
  await expect(anna.ui.getByRole('button', { name: 'a first date' })).toHaveAttribute('aria-pressed', 'true');
});

test('stored images that cannot be read come back empty', async ({ anna, host }) => {
  await enterStudio(anna);
  await expect.poll(() => host.imageKeys().length).toBeGreaterThan(0);
  await anna.evalApp(() => new Promise((r) => setTimeout(r, 900)), null);
  const saved = new Map(host.storage);
  const manifests = [...saved.entries()].filter(([k, v]) => k.startsWith('img/') && typeof v === 'object').map(([k]) => k);
  expect(manifests.length).toBeGreaterThan(0);

  const imageReplies: [string, (key: string) => RpcOutcome][] = [
    ['envelope error', () => envelopeError('APP_ERR_INTERNAL', 'boom')],
    ['bare, missing', () => bare({ value: null, exists: false })],
    ['no value', () => ok({})],
    ['null result', () => ok(null)],
    ['not found', () => reject('not_found', 'no such key')],
    ['host error', () => reject('APP_ERR_INTERNAL', 'storage down')],
    ['bad manifest', (k) => (manifests.includes(k) ? ok({ value: { chunks: 500 }, exists: true }) : bare({ value: saved.get(k), exists: true }))],
    ['odd manifest', (k) => (manifests.includes(k) ? ok({ value: { chunks: 'x' }, exists: true }) : bare({ value: saved.get(k), exists: true }))],
    ['missing chunk', (k) => (/\.\d+$/.test(k) ? ok({ value: null, exists: false }) : bare({ value: saved.get(k), exists: true }))],
  ];
  for (const [name, reply] of imageReplies) {
    host.storage = new Map(saved);
    host.on('storage.get', ({ key }) =>
      key.startsWith('img/') ? reply(key) : bare({ value: host.storage.get(key), exists: host.storage.has(key) }),
    );
    await anna.reopen();
    // Unreadable images load as empty (e.g. no twin → welcome screen), never an error.
    await expect(anna.ui.getByText('Opening your fitting room…'), name).toBeHidden();
    await expect(anna.ui.getByText(/Step in with the demo persona|Drop any screenshot/), name).toBeVisible();
    await expect(anna.ui.getByText('could not load', { exact: false }), name).toHaveCount(0);
  }
});

test('loading errors: just updated, or storage unavailable', async ({ anna, host }) => {
  host.on('storage.get', () => reject('APP_ERR_TOKEN', 'token version mismatch'));
  await anna.open();
  await expect(anna.ui.getByText('Anywear was just updated.')).toBeVisible();
  await expect(anna.ui.getByText('your twin, skin read and lookbook are safe', { exact: false })).toBeVisible();

  host.on('storage.get', () => reject('APP_ERR_INTERNAL', 'storage unavailable'));
  await anna.reopen();
  await expect(anna.ui.getByText('Anywear could not load your saved fitting room.')).toBeVisible();
});

test('host without large-value storage: photos live for the session only', async ({ anna, host }) => {
  const warned = warnings(anna);
  host.on('storage.set', ({ key, value }) => {
    if (String(key).startsWith('img/')) return reject('APP_ERR_VALUE_TOO_LARGE', 'too large');
    host.storage.set(key, value);
    return ok({});
  });
  await enterStudio(anna);
  await expect.poll(() => (host.storage.get('state/anywear') as any)?.state).toBeTruthy();
  expect((host.storage.get('state/anywear') as any).state.twinPhoto).toBeNull();
  expect(warned.some((w) => w.includes('image persistence unavailable'))).toBe(true);

  // Later saves skip images straight away.
  await anna.ui.getByRole('button', { name: 'the office' }).click();
  await hide(anna);
  await expect.poll(() => (host.storage.get('state/anywear') as any)?.state?.occasion).toBe('the office');

  await anna.reopen();
  await expect(anna.ui.getByRole('button', { name: 'Step in with the demo persona' })).toBeVisible();
});

test('failed saves and storage clean-up never break the App', async ({ anna, host }) => {
  const warned = warnings(anna);
  // The first two state writes are refused (without, then with details);
  // after that writes succeed with a bare reply.
  let stateWrites = 0;
  host.on('storage.set', ({ key, value }) => {
    if (key === 'state/anywear' && ++stateWrites <= 2) {
      return stateWrites === 1 ? envelopeError(undefined) : envelopeError('APP_ERR_QUOTA_EXCEEDED', 'storage full');
    }
    host.storage.set(key, value);
    return bare(null);
  });
  // Clean-up listing fails outright, then is refused, then answers bare.
  let lists = 0;
  host.on('storage.list', () => {
    lists++;
    if (lists === 1) return reject('APP_ERR_INTERNAL', 'list down');
    if (lists === 2) return envelopeError('APP_ERR_INTERNAL', 'list refused');
    return bare({ items: [{ key: 'img/orphan' }, { key: 'img/orphan.0' }], next_cursor: null });
  });
  host.storage.set('img/orphan', { chunks: 1 });
  host.storage.set('img/orphan.0', 'data');

  await enterStudio(anna);
  // The debounced save (timer path) is refused first.
  await expect.poll(() => warned.filter((w) => w.includes('persist failed')).length).toBe(1);
  const saveOccasion = async (occasion: string) => {
    await anna.ui.getByRole('button', { name: occasion }).click();
    await hide(anna);
    await expect.poll(() => (host.storage.get('state/anywear') as any)?.state?.occasion).toBe(occasion);
  };
  // Second refused write (hidden-window path), then ten good saves → the periodic clean-up runs twice.
  await anna.ui.getByRole('button', { name: 'a night out' }).click();
  await hide(anna);
  await expect.poll(() => warned.filter((w) => w.includes('persist failed')).length).toBe(2);
  for (let i = 0; i < 11; i++) await saveOccasion(i % 2 ? 'the office' : 'a first date');
  await expect.poll(() => lists).toBe(2);
  expect(warned.some((w) => w.includes('storage GC skipped'))).toBe(true);

  // A Start fresh save cleans up right away; the bare listing removes orphans.
  await anna.ui.getByRole('button', { name: 'Start fresh' }).click();
  await anna.ui.getByRole('button', { name: /Click again to clear/ }).click();
  await hide(anna);
  await expect.poll(() => host.storage.has('img/orphan')).toBe(false);
  expect(host.storage.has('img/orphan.0')).toBe(false);
});

test('closing while the skin brief is written: reopen offers Retry, not a stuck spinner', async ({ anna, host }) => {
  await enterStudio(anna);
  const ui = anna.ui;
  const writing = gate();
  host.llm.brief = async () => {
    await writing.wait();
    return llmText(JSON.stringify(BRIEF));
  };
  await ui.getByRole('button', { name: 'Read my skin' }).click();
  await expect(ui.getByText("Writing today's brief…")).toBeVisible();
  // The save records the unfinished brief as failed (it can't resume after a close).
  await hide(anna);
  await expect.poll(() => (host.storage.get('state/anywear') as any)?.state?.skin?.briefStatus).toBe('error');
  await anna.reopen();
  await expect(ui.getByText('Redness', { exact: true })).toBeVisible();
  await expect(ui.getByText("Writing today's brief…")).toHaveCount(0);
  host.llm.brief = () => llmText(JSON.stringify(BRIEF));
  await ui.getByRole('button', { name: 'Retry' }).click();
  await expect(ui.getByText(BRIEF.headline, { exact: false })).toBeVisible();
  writing.open();
});
