import { describe, expect, it } from 'vitest';
import { holdReason } from '../src/worker/lib/hold';

const r = (u: string, signals: string[] = [], referrer: string | null = null) =>
  holdReason({ url: new URL(u), referrer, signals, siteHost: 'enewspf.com' });

describe('server-side hold for proxy bots', () => {
  it('holds a Direct visit whose browser timezone does not match its IP', () => {
    expect(r('https://enewspf.com/story', ['tz_mismatch'])).toBe('tz_mismatch');
  });
  it('holds a Direct visit that starts deep in an archive', () => {
    expect(r('https://enewspf.com/category/latest-national-news/page/1192')).toBe('deep_archive');
    expect(r('https://enewspf.com/page/62/')).toBe('deep_archive');
    expect(r('https://enewspf.com/page/3')).toBeNull();
  });
  it('never holds visits that came from somewhere else or carry campaign tags', () => {
    expect(r('https://enewspf.com/story', ['tz_mismatch'], 'https://www.google.com/')).toBeNull();
    expect(r('https://enewspf.com/story?utm_source=newsletter', ['tz_mismatch'])).toBeNull();
    expect(r('https://enewspf.com/page/99?fbclid=x')).toBeNull();
  });
  it('treats a referrer from the same site as Direct', () => {
    expect(r('https://enewspf.com/story', ['tz_mismatch'], 'https://www.enewspf.com/')).toBe('tz_mismatch');
  });
  it('lets ordinary Direct visits through', () => {
    expect(r('https://enewspf.com/story', ['old_script'])).toBeNull();
  });
});
