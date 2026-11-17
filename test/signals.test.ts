import { describe, expect, it } from 'vitest';
import { botSignals, currentChromeMajor } from '../src/worker/lib/signals';

const NOW = Date.UTC(2026, 10, 17);
const chrome = (v: number) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const base = { ua: chrome(155), secChUa: '"Chromium";v="155", "Google Chrome";v="155"', browserTz: 'America/Chicago', ipTz: 'America/Chicago', direct: true, now: NOW };

describe('bot signals', () => {
  it('passes a normal, current Chrome', () => {
    expect(botSignals(base)).toEqual([]);
  });
  it('treats timezones with the same offset as a match', () => {
    expect(botSignals({ ...base, browserTz: 'America/Mexico_City', ipTz: 'America/Chicago' })).toEqual([]);
    expect(botSignals({ ...base, browserTz: 'Asia/Shanghai' })).toEqual(['tz_mismatch']);
    expect(botSignals({ ...base, browserTz: 'Not/A_Zone' })).toEqual([]);
    expect(botSignals({ ...base, ipTz: null })).toEqual([]);
  });
  it('flags Chrome without client hints, or headless ones, only when the request came straight from the browser', () => {
    expect(botSignals({ ...base, secChUa: null })).toEqual(['no_client_hints']);
    expect(botSignals({ ...base, secChUa: '"HeadlessChrome";v="155"' })).toEqual(['headless']);
    expect(botSignals({ ...base, secChUa: null, direct: false })).toEqual([]);
  });
  it('does not expect client hints from Safari, Firefox or iOS browsers', () => {
    const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0 Mobile/15E148 Safari/604.1';
    expect(botSignals({ ...base, ua: safari, secChUa: null })).toEqual([]);
  });
  it('flags desktop Chrome a year or more out of date', () => {
    expect(currentChromeMajor(NOW)).toBeGreaterThanOrEqual(154);
    expect(botSignals({ ...base, ua: chrome(48) })).toEqual(['old_chrome']);
    expect(botSignals({ ...base, ua: chrome(150) })).toEqual([]);
  });
});
