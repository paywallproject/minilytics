import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
const SRC = readFileSync(new URL('../public/js/script.js', import.meta.url), 'utf8');
it('re-reports once 15.5s visible in total, after a tab switch; later pages of a young visit get early pings', () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const run = (cookieIn: string) => {
    const sent: any[] = []; const dl: Record<string, any[]> = {}; let cookie = cookieIn;
    const timers: { at: number; fn: () => void }[] = [];
    const document: any = { currentScript: { src: 'https://m.example/js/script.js', getAttribute: (k: string) => (k === 'data-website-id' ? 'site12345' : null), hasAttribute: () => false },
      referrer: '', visibilityState: 'visible', readyState: 'complete', documentElement: {}, querySelectorAll: () => [],
      addEventListener(t: string, f: any) { (dl[t] ??= []).push(f); },
      get cookie() { return cookie; }, set cookie(v: string) { const [pair] = v.split(';'); const [k] = pair.split('='); const rest = cookie.split('; ').filter((c) => c && !c.startsWith(k + '=')); if (!/max-age=0/.test(v)) rest.push(pair); cookie = rest.join('; '); } };
    const window: any = { location: new URL('https://news.example/story'), navigator: { webdriver: false }, screen: { width: 1440 }, history: { pushState() {}, replaceState() {} }, addEventListener() {}, removeEventListener() {} };
    const fetch = (_u: string, o: any) => { sent.push(JSON.parse(o.body)); return Promise.resolve(); };
    new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'localStorage', 'URL', 'URLSearchParams', 'Intl', 'crypto', 'Blob', 'MutationObserver', 'screen', SRC)(
      window, document, fetch, () => 0, (fn: () => void, ms = 0) => (timers.push({ at: Date.now() + ms, fn }), 0), { getItem: () => null, setItem() {}, removeItem() {} }, URL, URLSearchParams, Intl, globalThis.crypto, Blob, undefined, window.screen);
    const tick = (ms: number) => { const end = Date.now() + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); vi.setSystemTime(t.at); t.fn(); } vi.setSystemTime(end); };
    const vis = (v: string) => { document.visibilityState = v; (dl.visibilitychange ?? []).forEach((f) => f()); };
    return { sent, tick, vis, cookie: () => cookie };
  };
  const t = run('');
  t.tick(5000);                 // 5s visible
  t.vis('hidden'); t.tick(60000); // checks the dashboard for a minute
  t.vis('visible'); t.tick(10700);
  const pings = t.sent.filter((e) => e.t === 'ping').map((e) => e.d);
  expect(pings.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(15500);
  const t2 = run(t.cookie()); // second page of the same young visit
  t2.tick(3600);
  expect(t2.sent.filter((e) => e.t === 'ping').length).toBe(2);
  vi.useRealTimers();
});
