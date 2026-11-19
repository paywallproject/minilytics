import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const SRC = readFileSync(new URL('../public/js/script.js', import.meta.url), 'utf8');
it('runs calls queued before the script loaded', () => {
  const sent: any[] = []; let cookie = '';
  const document: any = { currentScript: { src: 'https://m.example/js/script.js', getAttribute: (k: string) => (k === 'data-website-id' ? 'site12345' : null), hasAttribute: () => false },
    referrer: '', visibilityState: 'visible', readyState: 'complete', documentElement: {}, querySelectorAll: () => [], addEventListener() {},
    get cookie() { return cookie; }, set cookie(v: string) { cookie = v.split(';')[0]; } };
  const window: any = { minilytics: { q: [['goal', 'paywall_shown']] }, location: new URL('https://news.example/story'), navigator: { webdriver: false }, screen: { width: 1440 }, history: {}, addEventListener() {}, removeEventListener() {} };
  const fetch = (_u: string, o: any) => { sent.push(JSON.parse(o.body)); return Promise.resolve(); };
  new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'localStorage', 'URL', 'URLSearchParams', 'Intl', 'crypto', 'Blob', 'MutationObserver', 'screen', SRC)(
    window, document, fetch, () => 0, () => 0, { getItem: () => null, setItem() {}, removeItem() {} }, URL, URLSearchParams, Intl, globalThis.crypto, Blob, undefined, window.screen);
  expect(sent.map((e) => e.t)).toContain('goal');
});
