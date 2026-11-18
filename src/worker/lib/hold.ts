/**
 * Server-side hold for proxy bots: the same rule on every site, nothing to set up per site.
 *
 * Residential-proxy crawlers run real Chrome on home connections, so the browser and network checks can't tell
 * them from people. Two things give them away on their first page:
 *  - the browser's timezone doesn't match the IP's location (the machine is in one place, the proxy exit in
 *    another): 79% of the enewspf crawler and 49-63% of Direct visits on hardwick, groton and chilkat, against
 *    1-5% of visits from search and none of 72 Direct visits by paying readers;
 *  - the first page is deep in an archive (/page/1192, /category/x/page/545), which people only reach by clicking
 *    through from page 1, i.e. not as a brand-new Direct visit.
 * Such a visit is held, not dropped: if the reader interacts, logs in or clicks out, it's counted as normal. A
 * traveller or VPN user who never touches the page goes uncounted, which is the accepted cost.
 */

/** Holding only applies to a brand-new Direct visit (no referrer from elsewhere, no campaign tags). */
export function holdReason(input: { url: URL; referrer: string | null | undefined; signals: string[]; siteHost: string }): string | null {
  const { url, referrer, signals } = input;
  if (/[?&](utm_\w+|ref|via|gclid|fbclid|msclkid)=/i.test(url.search)) return null;
  if (referrer) {
    try {
      const h = new URL(referrer).hostname.replace(/^www\./, '');
      const own = input.siteHost.replace(/^www\./, '');
      if (h && h !== own && !h.endsWith('.' + own)) return null; // came from somewhere else
    } catch {
      /* unparseable referrer: treat as none */
    }
  }
  if (signals.includes('tz_mismatch')) return 'tz_mismatch';
  const page = url.pathname.match(/\/page\/(\d+)\/?$/);
  if (page && Number(page[1]) >= 10) return 'deep_archive';
  return null;
}

/** How long a held visit waits for a sign of a person. */
export const HOLD_MS = 3 * 3_600_000;

/** Events that prove a person is there. A goal doesn't: sites fire some on page load (e.g. "paywall shown"). */
export const RELEASES = new Set(['engage', 'identify', 'outbound']);
