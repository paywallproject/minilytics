import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../public/js/script.js', import.meta.url), 'utf8');

/** Runs the tracker in a tiny fake browser and returns what it sent plus a way to fire events. */
function run(opts: { referrer?: string; search?: string; cookie?: string; attrs?: Record<string, string>; optIn?: boolean } = {}) {
  const sent: any[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  let cookie = opts.cookie ?? '';
  const attrs: Record<string, string> = { 'data-website-id': 'site12345', ...(opts.optIn === false ? {} : { 'data-require-interaction': '' }), ...opts.attrs };
  const document: any = {
    currentScript: { src: 'https://m.example/js/script.js', getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs },
    referrer: opts.referrer ?? '',
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: {},
    addEventListener() {},
    querySelectorAll: () => [],
    get cookie() { return cookie; },
    set cookie(v: string) {
      const [pair] = v.split(';');
      const [k] = pair.split('=');
      const rest = cookie.split('; ').filter((c) => c && !c.startsWith(k + '='));
      if (!/max-age=0/.test(v)) rest.push(pair);
      cookie = rest.join('; ');
    },
  };
  const window: any = {
    location: new URL('https://news.example/story' + (opts.search ?? '')),
    navigator: { webdriver: false },
    screen: { width: 1440 },
    history: { pushState() {}, replaceState() {} },
    addEventListener(t: string, fn: any) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: any) { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
  };
  const fetch = (_u: string, o: any) => { sent.push(JSON.parse(o.body)); return Promise.resolve(); };
  new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'localStorage', 'URL', 'URLSearchParams', 'Intl', 'crypto', 'Blob', 'MutationObserver', 'screen',
    SRC,
  )(window, document, fetch, () => 0, () => 0, { getItem: () => null, setItem() {}, removeItem() {} }, URL, URLSearchParams, Intl, globalThis.crypto, Blob, undefined, window.screen);
  const fire = (t: string, trusted = true) => (listeners[t] ?? []).slice().forEach((f) => f({ isTrusted: trusted }));
  const api = (...a: any[]) => window.minilytics(...a);
  return { sent, fire, api };
}

describe('tracker: Direct visits wait for a sign of a person', () => {
  it('holds a new Direct visit until the visitor moves, scrolls, taps or types', () => {
    const t = run();
    expect(t.sent).toEqual([]);
    t.fire('pointermove', false); // scripted events do not count
    expect(t.sent).toEqual([]);
    t.fire('scroll');
    expect(t.sent.map((e) => e.t)).toEqual(['pageview', 'engage']);
    expect(t.sent[0].u).toBe('https://news.example/story');
  });
  it('counts visits with a referrer, campaign tags or an existing session straight away', () => {
    expect(run({ referrer: 'https://www.google.com/' }).sent.map((e) => e.t)).toEqual(['pageview']);
    expect(run({ referrer: 'https://news.example/other-page' }).sent).toEqual([]); // same-site referrer, no session yet
    expect(run({ search: '?utm_source=newsletter' }).sent.map((e) => e.t)).toEqual(['pageview']);
    expect(run({ cookie: 'ml_sid=abcdefgh-1234' }).sent.map((e) => e.t)).toEqual(['pageview']);
  });
  it('counts every visit straight away on sites without data-require-interaction', () => {
    const t = run({ optIn: false });
    expect(t.sent.map((e) => e.t)).toEqual(['pageview']);
    t.fire('scroll');
    expect(t.sent.map((e) => e.t)).toEqual(['pageview', 'engage']);
  });
  it('keeps goals with the held pageview until a sign of a person (a goal can fire on page load)', () => {
    const t = run();
    t.api('goal', 'paywall_shown_free');
    expect(t.sent).toEqual([]);
    t.fire('scroll');
    expect(t.sent.map((e) => e.t)).toEqual(['pageview', 'goal', 'engage']);
    expect(t.sent[1].n ?? t.sent[1].name ?? JSON.stringify(t.sent[1])).toContain('paywall_shown_free');
  });
  it('sends the held pageview and anything waiting when the reader logs in', () => {
    const t = run();
    t.api('goal', 'paywall_shown_free');
    t.api('identify', { user_id: '7' });
    expect(t.sent.map((e) => e.t)).toEqual(['pageview', 'goal', 'identify']);
  });
});
