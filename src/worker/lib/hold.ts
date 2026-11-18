/**
 * The hold: the same rule on every site, nothing to set up per site.
 *
 * Residential-proxy crawlers run real Chrome on home connections and can fake a Google referrer, so network,
 * browser and referrer checks can't tell them from people. What they don't do is look at the page. So a brand-new
 * visitor's first visit is held (not counted) until there's a sign that someone saw it; how strong a sign is needed
 * depends on how the visit looks. Returning visitors are never held.
 *
 * Measured on every site's first visits from 2026-11-17 09:00 to 2026-11-18 02:20 UTC, with people who came back
 * later or are known (logged in or paid) as the real readers (1,717) and everyone else as one-time (8,884):
 *  - automated: headless, or old Chrome without the client hints real Chrome sends. 0 real readers, 208 one-time.
 *    Only a login counts.
 *  - strict: browser timezone doesn't match the IP's location (2.2% of real readers vs 24% of one-time), old
 *    Chrome (0.3% vs 7.3%), no client hints (0.1% vs 2.8%), Linux on a computer (0.6% vs 3.5%), first page deep in
 *    an archive (0% vs 4.3%). Counted after an interaction plus 3s on screen, or 15s on screen.
 *  - outside: from a country the site's real readers don't come from (audience.ts), any device. Counted after an
 *    interaction plus 15s on screen, or a login. 1.0% of real readers' first visits vs 11% of one-time.
 *  - light: any other new visit on a computer. From outside the site's home region (state), time on the page alone
 *    doesn't count it (audience.ts inHomeRegion). Counted after any interaction, any time on screen (the tracker
 *    reports after about a second), a second page, a login or a click out.
 * Together: 2.9% of real readers' first visits not counted (mostly visits never on screen; they're counted when
 * they come back), and 34% of one-time visits. Phones without a strict sign aren't held yet: the old tracker didn't
 * report time on iPhones, so they couldn't be measured fairly (re-check with the early pings).
 */

export type Tier = 'automated' | 'outside' | 'strict' | 'light';

const TIER: Record<string, Tier> = {
  automated: 'automated',
  outside_audience: 'outside',
  tz_mismatch: 'strict',
  old_browser: 'strict',
  linux_desktop: 'strict',
  deep_archive: 'strict',
  new_desktop: 'light',
  new_desktop_far: 'light',
};

export const tierOf = (reason: string): Tier => TIER[reason] ?? 'strict';

/** Why a brand-new visitor's first visit is held, or null to count it straight away. */
export function holdReason(input: { url: URL; signals: string[]; device?: string; os?: string; outside?: boolean; far?: boolean }): string | null {
  const { url, signals } = input;
  const has = (s: string) => signals.includes(s);
  if (has('headless') || (has('no_client_hints') && has('old_chrome'))) return 'automated';
  // From a country the site's real readers don't come from (audience.ts), on any device: the Nanjing crawler on
  // enewspf carries no other sign and keeps each page open 15s+.
  if (input.outside) return 'outside_audience';
  if (has('tz_mismatch')) return 'tz_mismatch';
  if (has('old_chrome') || has('no_client_hints')) return 'old_browser';
  if (input.os === 'Linux' && input.device === 'Desktop') return 'linux_desktop';
  const page = url.pathname.match(/\/page\/(\d+)\/?$/);
  if (page && Number(page[1]) >= 10) return 'deep_archive';
  // From outside the site's home region (audience.ts), time on the page alone doesn't count (see releasedBy).
  if (input.device === 'Desktop') return input.far ? 'new_desktop_far' : 'new_desktop';
  return null;
}

/** Held visits (counted or not) are kept this long so the hold can be checked, then deleted. */
export const HELD_KEEP_MS = 7 * 86_400_000;

/** Strict: an interaction counts with this much time on screen (crawlers fake a mouse move and leave at once). */
export const STRICT_ENGAGED_MS = 3_000;
/** Strict: time on screen alone counts from here (except automated). */
export const STRICT_VISIBLE_MS = 15_000;

/** Should a held visit be counted now, given what it has done so far? */
export function releasedBy(held: { reason: string; visible: number; engaged: number }): boolean {
  switch (tierOf(held.reason)) {
    case 'automated':
      return false;
    case 'outside':
      return !!held.engaged && held.visible >= STRICT_VISIBLE_MS;
    case 'strict':
      return (!!held.engaged && held.visible >= STRICT_ENGAGED_MS) || held.visible >= STRICT_VISIBLE_MS;
    case 'light':
      // From outside the site's home region, time alone isn't enough: crawlers on home connections across the
      // country sit on pages without touching them, while a local paper's readers are local.
      return !!held.engaged || (held.visible > 0 && held.reason !== 'new_desktop_far');
  }
}

/** Events that count a held visit on their own: logging in always; clicking a link out unless automated. */
export function releasedByEvent(reason: string, type: string): boolean {
  if (type === 'identify') return true;
  return type === 'outbound' && tierOf(reason) !== 'automated' && tierOf(reason) !== 'outside';
}

/** A second page counts a light hold (people click through; these crawlers load one page). */
export const releasedByPage = (reason: string) => tierOf(reason) === 'light';
