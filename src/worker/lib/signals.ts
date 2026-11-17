import { tzOffset } from './time';

/**
 * Signs that a visit came from an automated browser that got past the user-agent and network filters
 * (stealth headless Chrome on residential proxies). Recorded on the session so each signal can be checked
 * against real traffic before it is used to hide anything.
 */
export interface SignalInput {
  ua: string;
  /** The `sec-ch-ua` request header, or null when absent. */
  secChUa: string | null;
  /** The browser's own IANA timezone, as the tracker reports it. */
  browserTz: unknown;
  /** The timezone of the visitor's IP address, or null when unknown (e.g. the script is proxied). */
  ipTz: string | null;
  /** False when the request reached us through the site's own server, which may drop browser headers. */
  direct: boolean;
  now: number;
}

// Chrome 131 shipped on 2024-11-12 and a new major version ships every 4 weeks.
const CHROME_131 = Date.UTC(2024, 10, 12);
export const currentChromeMajor = (now: number) => 131 + Math.floor((now - CHROME_131) / (28 * 86_400_000));
// Chrome updates itself; a desktop copy a year behind is almost always a hard-coded user agent.
const STALE_CHROME_VERSIONS = 12;

function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function botSignals(i: SignalInput): string[] {
  const out: string[] = [];
  // Chromium on desktop or Android (not iOS, where every browser is Safari underneath).
  const chrome = /Chrome\/(\d+)/.exec(i.ua);
  const chromium = !!chrome && !/CriOS|EdgiOS|FxiOS|Firefox\//.test(i.ua);

  if (i.direct && chromium) {
    if (i.secChUa === null) out.push('no_client_hints');
    else if (/Headless/i.test(i.secChUa)) out.push('headless');
  }
  if (chromium && /Windows NT|Macintosh|X11/.test(i.ua) && Number(chrome![1]) < currentChromeMajor(i.now) - STALE_CHROME_VERSIONS) {
    out.push('old_chrome');
  }
  if (i.ipTz && validTz(i.ipTz) && validTz(i.browserTz) && tzOffset(i.browserTz, i.now) !== tzOffset(i.ipTz, i.now)) {
    out.push('tz_mismatch');
  }
  return out;
}
