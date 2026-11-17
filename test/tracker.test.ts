import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../public/js/script.js', import.meta.url), 'utf8');

/** Runs the tracker in a tiny fake browser and returns what it sent plus a way to fire events. */
function run(opts: { referrer?: string; search?: string; cookie?: string; attrs?: Record<string, string>; optIn?: boolean; storage?: Record<string, string> } = {}) {
  const timers: (() => void)[] = [];
  const frames: any[] = [];
  const store: Record<string, string> = { ...opts.storage };
  const session: Record<string, string> = {};
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
    body: { appendChild: (f: any) => { f.parentNode = { removeChild() {} }; frames.push(f); } },
    createElement: () => ({ style: {}, setAttribute() {} }),
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
    sessionStorage: { getItem: (k: string) => session[k] ?? null, setItem: (k: string, v: string) => { session[k] = v; } },
    addEventListener(t: string, fn: any) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t: string, fn: any) { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
  };
  const fetch = (_u: string, o: any) => { sent.push(JSON.parse(o.body)); return Promise.resolve(); };
  new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'localStorage', 'URL', 'URLSearchParams', 'Intl', 'crypto', 'Blob', 'MutationObserver', 'screen',
    SRC,
  )(window, document, fetch, () => 0, (fn: () => void) => { timers.push(fn); return 0; }, { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem() {} }, URL, URLSearchParams, Intl, globalThis.crypto, Blob, undefined, window.screen);
  const fire = (t: string, trusted = true) => (listeners[t] ?? []).slice().forEach((f) => f({ isTrusted: trusted }));
  const api = (...a: any[]) => window.minilytics(...a);
  const runTimers = () => timers.splice(0).forEach((fn) => fn());
  return { sent, fire, api, frames, runTimers };
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
  it('sends the held pageview before a goal', () => {
    const t = run();
    t.api('goal', 'Signup');
    expect(t.sent.map((e) => e.t)).toEqual(['pageview', 'goal']);
  });
});

describe('tracker: human check (Turnstile)', () => {
  it('opens one hidden frame on the Minilytics domain, with only the site and visit ids in the #fragment', () => {
    const t = run({ optIn: false });
    t.runTimers();
    expect(t.frames).toHaveLength(1);
    const src = new URL(t.frames[0].src);
    expect(src.origin + src.pathname).toBe('https://m.example/api/human/frame');
    expect(src.search).toBe('');
    expect([...new URLSearchParams(src.hash.slice(1)).keys()]).toEqual(['w', 'sid', 'vid']);
    expect(t.frames[0].style.cssText).toContain('left:-9999px');
  });
  it('skips browsers that passed in the last 30 days', () => {
    const t = run({ optIn: false, storage: { ml_h: String(Date.now() - 86_400_000) } });
    t.runTimers();
    expect(t.frames).toHaveLength(0);
  });
});
