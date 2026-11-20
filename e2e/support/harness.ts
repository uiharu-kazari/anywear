// E2E harness: plays the Anna host (sandboxed iframe + SDK RPC) and the
// self-hosted web server's /api, serves the built bundles, and collects
// istanbul coverage from every app document before it goes away.

import { test as base, expect, type Frame, type FrameLocator, type Page, type Route } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANNA_DIR = path.resolve(E2E, '..', process.env.E2E_ANNA_DIR ?? 'e2e/.build/anna');
const WEB_DIR = path.join(E2E, '.build', 'web');
const NYC_DIR = path.join(E2E, '.nyc_output');
export const SAMPLE_DIR = path.resolve(E2E, '..', 'public', 'samples');
export const sample = (name: string) => path.join(SAMPLE_DIR, name);

export const ANNA_ORIGIN = 'http://anna.test';
export const APP_PATH = '/anna-apps/anywear/0.1.6/';
export const WEB_ORIGIN = 'http://web.test';
export const CDN = 'https://cdn.test';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const CORS = { 'Access-Control-Allow-Origin': '*' };

function serveFile(route: Route, file: string, extraHeaders: Record<string, string> = CORS) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, headers: extraHeaders, body: 'not found' });
  return route.fulfill({
    status: 200,
    headers: { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', ...extraHeaders },
    body: fs.readFileSync(file),
  });
}

// Real Anna serves Apps into an opaque-origin sandboxed iframe without
// `allow-modals`, so alert/confirm/prompt are silently blocked.
const HOST_HTML = `<!doctype html><html><head><title>Anna host (test)</title></head>
<body style="margin:0;background:#ddd">
<iframe id="app" title="Anywear" sandbox="allow-scripts allow-forms allow-popups allow-downloads"
  src="${APP_PATH}index.html" style="border:0;width:1280px;height:840px;display:block"></iframe>
</body></html>`;

// --- Model replies -------------------------------------------------------------

export type LlmKind = 'garments' | 'skin' | 'brief' | 'verdict';

export const GARMENTS_TWO = [
  { label: 'Sage slip dress', category: 'full_body', box_2d: [80, 80, 960, 470], description: 'Sage satin slip dress, bias cut.', confidence: 0.92 },
  { label: 'Camel blazer', category: 'upper_body', box_2d: [120, 530, 560, 920], description: 'Single-breasted camel blazer.', confidence: 0.81 },
];
export const GARMENT_ONE = [GARMENTS_TWO[1]];
export const SKIN_READ = {
  scores: { redness: 64, oiliness: 71, moisture: 58, radiance: 77, acne: 83, texture: 69 },
  skin_type: 'Combination',
};
export const BRIEF = {
  headline: 'Calm, a little thirsty today',
  summary: 'Clarity and radiance lead; moisture and redness need care.',
  care_focus: [
    { title: 'Moisture', why: 'Lowest score.', action: 'Layer a hydrating serum.' },
    { title: 'Redness', why: 'Some visible warmth.', action: 'Skip hot showers.' },
  ],
  palette: {
    guidance: 'Cool, muted tones calm visible redness.',
    wear: [
      { hex: '#8A9A7B', name: 'Sage', why: 'Calms redness.' },
      { hex: '#7D93A8', name: 'Dusty blue', why: 'Cool contrast.' },
    ],
    avoid: [{ hex: '#B0413E', name: 'Brick red', why: 'Amplifies redness.' }],
  },
};
export const VERDICT = {
  verdict: 'wear_it',
  score: 87,
  headline: 'This is so you — wear it.',
  reasons: ['The bias cut skims your frame.', 'Sage flatters your undertone.'],
  skin_harmony: 'Sage sits right in today’s calming palette.',
  pairing: ['Strappy sandals', 'A cropped knit'],
};

/** What the host does for one RPC: resolve with `value`, or reject like the SDK. */
export type RpcOutcome = { value: unknown } | { reject: { code?: string; message: string } };
export const ok = (result: unknown): RpcOutcome => ({ value: { ok: true, result } });
export const bare = (value: unknown): RpcOutcome => ({ value });
export const envelopeError = (code: string | undefined, message?: string): RpcOutcome => ({
  value: { ok: false, error: { code, message } },
});
export const reject = (code: string | undefined, message: string): RpcOutcome => ({ reject: { code, message } });
export const llmText = (text: string): RpcOutcome => ok({ content: { type: 'text', text } });

type Rpc = { ns: string; method: string; args: any };
type Handler = (args: any, rpc: Rpc) => RpcOutcome | Promise<RpcOutcome>;

function llmKind(args: any): LlmKind {
  const first = args.messages[0].content as { type: string; text?: string }[];
  const text = first.map((c) => c.text ?? '').join('');
  if (text.includes('Detect every distinct wearable')) return 'garments';
  if (text.includes('careful beauty-and-styling')) return 'skin';
  if (text.includes('stylist-facing skin interpreter')) return 'brief';
  if (text.includes('honest personal stylist')) return 'verdict';
  throw new Error('Unknown LLM prompt: ' + text.slice(0, 80));
}

/** The Anna host: per-user storage, uploads, image generation and the LLM. */
export class AnnaHost {
  storage = new Map<string, unknown>();
  calls: Rpc[] = [];
  /** Default model replies; tests replace entries to script other answers. */
  llm: Record<LlmKind, (args: any, attempt: number) => RpcOutcome | Promise<RpcOutcome>> = {
    garments: () => llmText(JSON.stringify(GARMENTS_TWO)),
    skin: () => llmText(JSON.stringify(SKIN_READ)),
    brief: () => llmText('```json\n' + JSON.stringify(BRIEF) + '\n```'),
    verdict: () => llmText('Here you go: ' + JSON.stringify(VERDICT)),
  };
  /** HTTP status of CDN replies (non-200 → the App can only show the URL). */
  cdnStatus = 200;
  /** What the CDN serves for generated images / uploads. */
  cdnFile = path.join(SAMPLE_DIR, 'hero_result.jpg');
  /** Storage list page size, small so paging is exercised. */
  listPage = 2;
  private uploads = 0;
  private overrides = new Map<string, Handler>();

  /** Override one RPC, e.g. `host.on('upload.inline', () => reject(...))`. */
  on(name: string, fn: Handler) {
    this.overrides.set(name, fn);
  }
  off(name: string) {
    this.overrides.delete(name);
  }
  count(name: string) {
    return this.calls.filter((c) => `${c.ns}.${c.method}` === name).length;
  }
  imageKeys() {
    return [...this.storage.keys()].filter((k) => k.startsWith('img/'));
  }

  async handle(rpc: Rpc): Promise<RpcOutcome> {
    this.calls.push(rpc);
    const name = `${rpc.ns}.${rpc.method}`;
    const o = this.overrides.get(name);
    if (o) return o(rpc.args, rpc);
    return this.defaults(name, rpc.args);
  }

  defaults(name: string, args: any): RpcOutcome | Promise<RpcOutcome> {
    switch (name) {
      case 'runtime.connect':
        return bare({});
      case 'storage.get':
        return this.storage.has(args.key) ? ok({ value: this.storage.get(args.key), exists: true }) : ok({ value: null, exists: false });
      case 'storage.set':
        this.storage.set(args.key, args.value);
        return ok({});
      case 'storage.delete':
        this.storage.delete(args.key);
        return ok({});
      case 'storage.list': {
        const keys = [...this.storage.keys()].filter((k) => k.startsWith(args.prefix ?? '')).sort();
        // Key-based cursor ("after this key"), so deleting while paging is safe.
        const rest = args.cursor ? keys.filter((k) => k > args.cursor) : keys;
        const page = rest.slice(0, this.listPage);
        const next = rest.length > this.listPage ? page[page.length - 1] : null;
        return ok({ items: page.map((key) => ({ key })), next_cursor: next });
      }
      case 'upload.inline': {
        const n = ++this.uploads;
        return ok({ r2_key: `r2/${n}`, download_url: `${CDN}/u/${n}.jpg` });
      }
      case 'upload.confirm':
        return ok({ download_url: `${CDN}/u/${String(args.r2_key).split('/')[1]}.jpg?fresh` });
      case 'image.generate':
        return ok({ images: [{ url: `${CDN}/result.jpg` }] });
      case 'window.report_error':
        return ok({});
      case 'llm.complete': {
        const kind = llmKind(args);
        const attempt = args.messages.length - 1;
        return this.llm[kind](args, attempt);
      }
    }
    throw new Error('Unmocked Anna RPC ' + name);
  }
}

// --- Web server (/api) mock ------------------------------------------------------

export type ApiReply = { status?: number; json?: unknown; body?: string };
export class WebApi {
  calls: { method: string; path: string; body: any }[] = [];
  routes = new Map<string, (body: any, url: URL) => ApiReply | Promise<ApiReply>>();
  /** Status of /api/image-proxy for a given remote URL. */
  proxyStatus: (target: string) => number = () => 200;
  constructor() {
    this.routes.set('GET /api/credits', () => ({ json: { units: 412 } }));
    this.routes.set('POST /api/upload', () => ({ json: { fileId: 'file-twin' } }));
    this.routes.set('POST /api/skin/start', () => ({ json: { taskId: 'skin-1' } }));
    this.routes.set('GET /api/skin/status', () => ({
      json: {
        status: 'success',
        output: [
          { type: 'redness', ui_score: 64, raw_score: 40, mask_urls: ['https://yce.test/mask-redness.png'] },
          { type: 'oiliness', ui_score: 71, raw_score: 55 },
          { type: 'moisture', ui_score: 58 },
          { type: 'skin_type', skin_type: 'combination' },
          { type: 'skin_age', score: 27.4 },
          { type: 'all', ui_score: 70 },
          { type: 'wrinkle' },
        ],
      },
    }));
    this.routes.set('POST /api/skin/brief', () => ({ json: { brief: BRIEF } }));
    this.routes.set('POST /api/garments/detect', () => ({ json: { garments: GARMENTS_TWO } }));
    this.routes.set('POST /api/vto/start', () => ({ json: { taskId: 'vto-1' } }));
    this.routes.set('GET /api/vto/status', () => ({ json: { status: 'success', url: 'https://yce.test/vto.jpg' } }));
    this.routes.set('POST /api/stylist/verdict', () => ({ json: { verdict: VERDICT } }));
  }
  set(key: string, fn: (body: any, url: URL) => ApiReply | Promise<ApiReply>) {
    this.routes.set(key, fn);
  }
  count(key: string) {
    return this.calls.filter((c) => `${c.method} ${c.path}`.startsWith(key)).length;
  }
}

/** A latch to hold a mocked call until the test lets it through. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, wait: () => opened };
}

export const fixture = (name: string) => path.join(E2E, 'fixtures', name);

// --- Coverage ---------------------------------------------------------------

let covSeq = 0;
async function collectCoverage(target: Page | Frame | null | undefined, label: string) {
  if (!target) return;
  try {
    const cov = await target.evaluate(() => (window as unknown as { __coverage__?: unknown }).__coverage__ ?? null);
    if (!cov) return;
    fs.mkdirSync(NYC_DIR, { recursive: true });
    const id = crypto.createHash('sha1').update(`${label}#${process.pid}#${covSeq++}#${Date.now()}`).digest('hex');
    fs.writeFileSync(path.join(NYC_DIR, `${id}.json`), JSON.stringify(cov));
  } catch {
    // Document already gone (closed page): nothing to collect.
  }
}

// --- App drivers ---------------------------------------------------------------

/** Console noise that means the app used a native dialog in the sandbox. */
const BLOCKED_DIALOG = /Ignored call to '(alert|confirm|prompt)\(\)'/;

abstract class Driver {
  pageErrors: string[] = [];
  blockedDialogs: string[] = [];
  constructor(public page: Page, protected label: string) {
    page.on('pageerror', (e) => this.pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (BLOCKED_DIALOG.test(m.text())) this.blockedDialogs.push(m.text());
    });
  }
  abstract get ui(): FrameLocator | Page;
  abstract coverageTarget(): Page | Frame | null | undefined;
  async collect() {
    await collectCoverage(this.coverageTarget(), this.label);
  }
  /** Run JS inside the app document. */
  abstract evalApp<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

export class AnnaApp extends Driver {
  constructor(page: Page, public host: AnnaHost, label: string) {
    super(page, label);
  }
  get ui() {
    return this.page.frameLocator('#app');
  }
  frame() {
    return this.page.frames().find((f) => f.url().includes(APP_PATH));
  }
  coverageTarget() {
    return this.frame();
  }
  async evalApp<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    return this.frame()!.evaluate(fn, arg);
  }
  async install() {
    await this.page.route(`${ANNA_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/host') return route.fulfill({ status: 200, contentType: 'text/html', body: HOST_HTML });
      if (url.pathname === '/static/anna-apps/_sdk/latest/index.js') return serveFile(route, path.join(E2E, 'support', 'anna-sdk-mock.js'));
      if (url.pathname === '/__anna_rpc') {
        const rpc = JSON.parse(route.request().postData() ?? '{}') as Rpc;
        let out: RpcOutcome;
        try {
          out = await this.host.handle(rpc);
        } catch (e) {
          out = { reject: { code: 'harness_error', message: String(e) } };
        }
        return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(out) });
      }
      if (url.pathname.startsWith(APP_PATH)) return serveFile(route, path.join(ANNA_DIR, url.pathname.slice(APP_PATH.length)));
      return route.fulfill({ status: 404, body: 'not found' });
    });
    await this.page.route(`${CDN}/**`, (route) =>
      this.host.cdnStatus === 200
        ? serveFile(route, this.host.cdnFile)
        : route.fulfill({ status: this.host.cdnStatus, headers: CORS, body: 'denied' }),
    );
  }
  /** Open the App window (storage persists across opens, like a real account). */
  async open() {
    await this.page.goto(`${ANNA_ORIGIN}/host`);
    await this.page.waitForFunction(() => document.querySelector('iframe')?.contentWindow != null);
    await expect.poll(() => this.frame() != null).toBe(true);
  }
  /** Close and reopen the App window. */
  async reopen() {
    await this.collect();
    await this.open();
  }
  /** Uninstall + reinstall: all of the user's App storage is gone. */
  async freshInstall() {
    await this.collect();
    this.host.storage.clear();
    await this.open();
  }
}

export class WebApp extends Driver {
  constructor(page: Page, public api: WebApi, label: string) {
    super(page, label);
  }
  get ui() {
    return this.page;
  }
  coverageTarget() {
    return this.page;
  }
  async evalApp<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    return this.page.evaluate(fn, arg);
  }
  async install() {
    await this.page.route(`${WEB_ORIGIN}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/api/image-proxy') {
        this.api.calls.push({ method: 'GET', path: url.pathname + url.search, body: null });
        const status = this.api.proxyStatus(url.searchParams.get('url')!);
        if (status !== 200) return route.fulfill({ status, body: 'upstream failed' });
        return serveFile(route, path.join(SAMPLE_DIR, 'hero_result.jpg'), {});
      }
      if (url.pathname.startsWith('/api/')) {
        const base = url.pathname.replace(/\/(skin|vto)\/status\/.*/, '/$1/status');
        const key = `${req.method()} ${base}`;
        const body = req.postData() ? JSON.parse(req.postData()!) : null;
        this.api.calls.push({ method: req.method(), path: url.pathname, body });
        const fn = this.api.routes.get(key);
        if (!fn) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no route"}' });
        const r = await fn(body, url);
        return route.fulfill({
          status: r.status ?? 200,
          contentType: 'application/json',
          body: r.body ?? JSON.stringify(r.json ?? {}),
        });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return serveFile(route, path.join(WEB_DIR, file), {});
    });
  }
  async open() {
    await this.page.goto(`${WEB_ORIGIN}/`);
  }
  async reopen() {
    await this.collect();
    await this.page.reload();
  }
}

type Fixtures = { host: AnnaHost; anna: AnnaApp; webApi: WebApi; web: WebApp };

export const test = base.extend<Fixtures>({
  host: async ({}, use) => use(new AnnaHost()),
  anna: async ({ page, host }, use, info) => {
    const app = new AnnaApp(page, host, info.titlePath.join(' > '));
    await app.install();
    await use(app);
    await app.collect();
    expect(app.pageErrors, 'uncaught errors in the App').toEqual([]);
    expect(app.blockedDialogs, 'native dialogs are blocked in the Anna sandbox').toEqual([]);
  },
  webApi: async ({}, use) => use(new WebApi()),
  web: async ({ page, webApi }, use, info) => {
    const app = new WebApp(page, webApi, info.titlePath.join(' > '));
    await app.install();
    await use(app);
    await app.collect();
    expect(app.pageErrors, 'uncaught errors in the app').toEqual([]);
  },
});

export { expect };
