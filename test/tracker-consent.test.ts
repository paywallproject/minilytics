import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const SRC = readFileSync(new URL('../public/js/script.js', import.meta.url), 'utf8');

const CK = 'ck0123456789abcdef0123456789abcd';

/** Runs the tracker with data-consent on a page, optionally with a consentmanager.net banner (__cmp). */
function run(opts: { cmp?: { measurement: boolean }; preload?: unknown[][]; cookie?: string }) {
  const sent: any[] = [];
  let cookie = opts.cookie ?? '';
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const attrs: Record<string, string> = { 'data-website-id': 'site12345', 'data-consent': '' };
  const document: any = {
    currentScript: { src: 'https://m.example/js/script.js', getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs },
    referrer: '', visibilityState: 'visible', readyState: 'complete', documentElement: {}, querySelectorAll: () => [], addEventListener() {},
    get cookie() { return cookie; },
    set cookie(v: string) {
      const [pair] = v.split(';'); const [k] = pair.split('=');
      const rest = cookie.split('; ').filter((c) => c && !c.startsWith(k + '='));
      if (!/max-age=0/.test(v)) rest.push(pair);
      cookie = rest.join('; ');
    },
  };
  const listeners: Record<string, () => void> = {};
  const cmp = opts.cmp;
  const window: any = {
    location: new URL('https://news.example/story'), navigator: { webdriver: false }, screen: { width: 390 }, history: {},
    addEventListener() {}, removeEventListener() {},
    minilytics: opts.preload ? { q: opts.preload } : undefined,
    __cmp: cmp
      ? (cmd: string, arg: any) => {
          if (cmd === 'getCMPData')
            return { purposesList: [{ id: 'c51', name: 'Function' }, { id: 'c54', name: 'Measurement' }], purposeConsents: { c51: true, c54: cmp.measurement } };
          if (cmd === 'addEventListener') listeners[arg[0]] = arg[1];
        }
      : undefined,
  };
  const fetch = (_u: string, o: any) => {
    const body = JSON.parse(o.body);
    sent.push(body);
    return Promise.resolve({ json: () => Promise.resolve(body.ck ? { vid: CK, sid: CK } : {}) });
  };
  const setTimeout = (fn: () => void, ms = 0) => (timers.push({ at: now + ms, fn }), 0);
  new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'localStorage', 'URL', 'URLSearchParams', 'Intl', 'crypto', 'Blob', 'MutationObserver', 'screen', SRC)(
    window, document, fetch, () => 0, setTimeout, { getItem: () => null, setItem() {}, removeItem() {} }, URL, URLSearchParams, Intl, globalThis.crypto, Blob, undefined, window.screen);
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.fn(); }
    now = end;
  };
  return { sent, tick, cookie: () => cookie, window, cmp, fire: (ev: string) => listeners[ev]?.() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

it('stores nothing until the banner allows measurement, then keeps the visit going under the same id', async () => {
  const t = run({ cmp: { measurement: false } });
  t.tick(10);
  const pv = t.sent.find((e) => e.t === 'pageview');
  expect(pv.ck).toBe(1);
  expect(t.cookie()).toBe('');
  expect(pv.fl).toBeUndefined(); // no browser setup hash before consent
  expect(pv.gs).toBeUndefined();
  await flush(); await flush(); // the server's answer: today's id

  t.cmp!.measurement = true;
  t.fire('consent');
  expect(t.cookie()).toContain(`ml_vid=${CK}`);
  expect(t.cookie()).toContain(`ml_sid=${CK}`);
  t.window.minilytics('goal', 'subscribe_click');
  const g = t.sent.find((e) => e.t === 'goal');
  expect(g.ck).toBeUndefined();
  expect(g.vid).toBe(CK);
});

it('counts normally right away when the reader allowed measurement on an earlier visit', () => {
  const t = run({ cmp: { measurement: true }, cookie: 'ml_vid=old-visitor-1' });
  t.tick(10);
  const pv = t.sent.find((e) => e.t === 'pageview');
  expect(pv.ck).toBeUndefined();
  expect(pv.vid).toBe('old-visitor-1');
});

it('deletes its cookies when the reader withdraws consent', () => {
  const t = run({ cmp: { measurement: true }, cookie: 'ml_vid=old-visitor-1' });
  t.tick(10);
  t.cmp!.measurement = false;
  t.fire('consentrejected');
  expect(t.cookie()).not.toContain('ml_vid');
  t.window.minilytics('goal', 'x');
  expect(t.sent.find((e) => e.t === 'goal').ck).toBe(1);
});

it('takes consent from minilytics("consent", true) on sites without consentmanager, before the first pageview', () => {
  const t = run({ preload: [['consent', true]] });
  t.tick(0);
  const pv = t.sent.find((e) => e.t === 'pageview');
  expect(pv.ck).toBeUndefined();
  expect(t.cookie()).toContain('ml_vid=');
});

it('waits with who a logged-in reader is until they allow measurement', () => {
  const t = run({ cmp: { measurement: false }, preload: [['identify', { email: 'a@b.c' }]] });
  t.tick(10);
  expect(t.sent.some((e) => e.t === 'identify')).toBe(false);
  t.cmp!.measurement = true;
  t.fire('consent');
  expect(t.sent.find((e) => e.t === 'identify').p.email).toBe('a@b.c');
});
