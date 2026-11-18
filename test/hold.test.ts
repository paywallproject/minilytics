import { describe, expect, it } from 'vitest';
import { holdReason, releasedBy, releasedByEvent, releasedByPage, tierOf } from '../src/worker/lib/hold';

const reason = (signals: string[] = [], o: { path?: string; device?: string; os?: string } = {}) =>
  holdReason({ url: new URL('https://news.example' + (o.path ?? '/story')), signals, device: o.device ?? 'Desktop', os: o.os ?? 'Windows' });

describe('the hold: which first visits wait', () => {
  it('treats headless browsers and old Chrome without client hints as automated', () => {
    expect(reason(['headless'])).toBe('automated');
    expect(reason(['no_client_hints', 'old_chrome', 'tz_mismatch'])).toBe('automated');
  });
  it('holds visits with a bot sign strictly, on any device and from any source', () => {
    expect(reason(['tz_mismatch'], { device: 'Mobile', os: 'iOS' })).toBe('tz_mismatch');
    expect(reason(['old_chrome'])).toBe('old_browser');
    expect(reason(['no_client_hints'])).toBe('old_browser');
    expect(reason([], { os: 'Linux' })).toBe('linux_desktop');
    expect(reason([], { path: '/category/news/page/545' })).toBe('deep_archive');
    expect(tierOf('tz_mismatch')).toBe('strict');
  });
  it('holds any other new visit on a computer lightly, and lets phones through', () => {
    expect(reason([], { path: '/page/3' })).toBe('new_desktop');
    expect(tierOf('new_desktop')).toBe('light');
    expect(reason([], { device: 'Mobile', os: 'Android' })).toBeNull();
    expect(reason(['old_script'], { device: 'Mobile', os: 'iOS' })).toBeNull();
  });
});

describe('the hold: what counts a held visit', () => {
  const h = (reason: string, visible: number, engaged = 0) => releasedBy({ reason, visible, engaged });
  it('light: any interaction or any time on screen', () => {
    expect(h('new_desktop', 0)).toBe(false);
    expect(h('new_desktop', 0, 1)).toBe(true);
    expect(h('new_desktop', 1200)).toBe(true);
    expect(releasedByPage('new_desktop')).toBe(true);
  });
  it('strict: an interaction plus 3s on screen, or 15s on screen', () => {
    expect(h('tz_mismatch', 0, 1)).toBe(false); // scripted mouse move, then gone
    expect(h('tz_mismatch', 3500, 1)).toBe(true);
    expect(h('tz_mismatch', 14000)).toBe(false);
    expect(h('tz_mismatch', 15500)).toBe(true);
    expect(releasedByPage('tz_mismatch')).toBe(false);
  });
  it('outside the audience: an interaction plus 15s on screen, or a login', () => {
    expect(holdReason({ url: new URL('https://news.example/story'), signals: [], device: 'Mobile', os: 'iOS', outside: true })).toBe('outside_audience');
    expect(h('outside_audience', 15500)).toBe(false); // the Nanjing crawler: 15.5s, no interaction
    expect(h('outside_audience', 3500, 1)).toBe(false);
    expect(h('outside_audience', 16000, 1)).toBe(true);
    expect(releasedByEvent('outside_audience', 'outbound')).toBe(false);
    expect(releasedByEvent('outside_audience', 'identify')).toBe(true);
    expect(releasedByPage('outside_audience')).toBe(false);
  });
  it('automated: only a login', () => {
    expect(h('automated', 60000, 1)).toBe(false);
    expect(releasedByEvent('automated', 'outbound')).toBe(false);
    expect(releasedByEvent('automated', 'identify')).toBe(true);
    expect(releasedByEvent('tz_mismatch', 'outbound')).toBe(true);
    expect(releasedByEvent('new_desktop', 'goal')).toBe(false);
  });
});
