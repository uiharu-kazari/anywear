// Persistence backend for the zustand store.
//
// Web: plain localStorage. Anna: the App window is a sandboxed iframe with an
// opaque origin, so localStorage is unavailable; state goes to Anna Persistent
// Storage (per-user, per-App, synced across the user's devices). Large data:
// URLs (photos, try-on results) are split out into content-addressed keys so
// unchanged images are never re-uploaded; APS caps one value at 256 KiB, so
// big images are further split into chunks (`img/<hash>` holds `{chunks: n}`,
// the data lives in `img/<hash>.0` … `img/<hash>.<n-1>`).

import type { StateStorage } from 'zustand/middleware';
import { AnnaError, IS_ANNA, anna } from './anna';

const IMG_PREFIX = 'img/';
const REF = 'aps-img:';
const CHUNK = 200_000; // chars per value, well under the 256 KiB APS row cap

function hash(s: string): string {
  // FNV-1a 32-bit + length: plenty to dedupe a handful of photos.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 7) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

function walk(v: unknown, fn: (s: string) => unknown): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, fn)]));
  return v;
}

async function getValue(key: string): Promise<unknown> {
  const rt = await anna();
  try {
    const res = (await rt.storage.get({ key })) as { ok?: boolean; result?: { value: unknown; exists?: boolean }; value?: unknown; exists?: boolean };
    const r = 'ok' in res ? (res.ok ? res.result : null) : res;
    if (!r || r.exists === false) return null;
    return r.value ?? null;
  } catch (err) {
    if (err instanceof AnnaError && err.code === 'not_found') return null;
    throw err;
  }
}

async function setValue(key: string, value: unknown): Promise<void> {
  const rt = await anna();
  const res = (await rt.storage.set({ key, value })) as { ok?: boolean; error?: { code: string; message: string } };
  if (res && res.ok === false) throw new AnnaError(res.error?.code ?? 'unknown', res.error?.message ?? 'storage.set failed');
}

async function setImage(key: string, data: string): Promise<void> {
  if (data.length <= CHUNK) return setValue(key, data);
  const n = Math.ceil(data.length / CHUNK);
  for (let i = 0; i < n; i++) await setValue(`${key}.${i}`, data.slice(i * CHUNK, (i + 1) * CHUNK));
  // Manifest last: a reader never sees a manifest whose chunks are missing.
  await setValue(key, { chunks: n });
}

async function getImage(key: string): Promise<string | null> {
  const v = await getValue(key);
  if (typeof v === 'string') return v;
  const n = (v as { chunks?: unknown } | null)?.chunks;
  if (typeof n !== 'number' || n < 1 || n > 100) return null;
  const parts = await Promise.all(Array.from({ length: n }, (_, i) => getValue(`${key}.${i}`)));
  return parts.every((p) => typeof p === 'string') ? parts.join('') : null;
}

const written = new Set<string>();
let imagesUnsupported = false;
let pending: { name: string; value: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let gcCountdown = 0;

async function flush() {
  if (!pending) return;
  const { name, value } = pending;
  pending = null;
  const images = new Map<string, string>();
  const skeleton = walk(JSON.parse(value), (s) => {
    if (!s.startsWith('data:image/')) return s;
    if (imagesUnsupported) return null;
    const key = IMG_PREFIX + hash(s);
    images.set(key, s);
    return REF + key;
  });
  try {
    for (const [key, data] of images) {
      if (written.has(key)) continue;
      await setImage(key, data);
      written.add(key);
    }
  } catch (err) {
    // Host without large-value storage (legacy 256 KiB runtime_state): keep
    // persisting the text state and let photos live for the session only.
    console.warn('[anywear] image persistence unavailable', err);
    imagesUnsupported = true;
    pending = { name, value };
    return flush();
  }
  await setValue(`state/${name}`, skeleton);
  // No live images (e.g. after "Start fresh") → collect now, so removed photos
  // don't linger in storage until the next periodic sweep.
  if (--gcCountdown <= 0 || (images.size === 0 && !imagesUnsupported)) {
    gcCountdown = 10;
    void collectGarbage(new Set(images.keys()));
  }
}

/** Delete stored images the current state no longer references. */
async function collectGarbage(live: Set<string>) {
  try {
    const rt = await anna();
    let cursor: string | undefined;
    do {
      const res = (await rt.storage.list({ prefix: IMG_PREFIX, cursor, limit: 200 })) as {
        ok?: boolean;
        result?: { items: { key: string }[]; next_cursor: string | null };
        items?: { key: string }[];
        next_cursor?: string | null;
      };
      const page = 'ok' in res ? res.result : res;
      for (const { key } of page?.items ?? []) {
        if (!live.has(key.replace(/\.\d+$/, ''))) {
          await rt.storage.delete({ key });
          written.delete(key);
        }
      }
      cursor = page?.next_cursor ?? undefined;
    } while (cursor);
  } catch (err) {
    console.warn('[anywear] storage GC skipped', err);
  }
}

const annaStorage: StateStorage = {
  async getItem(name) {
    const skeleton = await getValue(`state/${name}`);
    if (skeleton == null) return null;
    const refs = new Set<string>();
    walk(skeleton, (s) => (s.startsWith(REF) && refs.add(s.slice(REF.length)), s));
    const resolved = new Map<string, unknown>();
    await Promise.all(
      [...refs].map(async (key) => {
        const v = await getImage(key).catch(() => null);
        resolved.set(key, v);
        if (v) written.add(key);
      }),
    );
    const full = walk(skeleton, (s) => (s.startsWith(REF) ? (resolved.get(s.slice(REF.length)) ?? null) : s));
    return JSON.stringify(full);
  },
  setItem(name, value) {
    // The store writes on every update (incl. status polling); debounce.
    pending = { name, value };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush().catch((err) => console.warn('[anywear] persist failed', err));
    }, 800);
  },
  async removeItem(name) {
    const rt = await anna();
    await rt.storage.delete({ key: `state/${name}` }).catch(() => undefined);
  },
};

// Closing the App window right after a try-on must not drop the debounced
// write (e.g. the newest lookbook entry): flush as the page goes away.
if (IS_ANNA && typeof document !== 'undefined') {
  const flushNow = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    flush().catch((err) => console.warn('[anywear] persist failed', err));
  };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

export const appStorage = (): StateStorage => (IS_ANNA ? annaStorage : localStorage);
