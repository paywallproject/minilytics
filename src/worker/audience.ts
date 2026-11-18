/**
 * Each site's audience: the countries its real readers come from (visitors seen again on a later day, or logged in),
 * learned from the last 14 days. Used by the hold (lib/hold.ts): a brand-new visitor from outside it has to show more
 * before it's counted. Same rule on every site; nothing to set up.
 */

const WINDOW_MS = 14 * 86_400_000;
/** Enough real readers to say where a site's audience is; below this, fall back to its main country. */
const MIN_READERS = 30;

/** Recompute one site's audience. One pass over its last 14 days of sessions (by the site/time index). */
export async function refreshAudience(db: D1Database, siteId: string, now = Date.now()) {
  const since = now - WINDOW_MS;
  const [readers, all] = await db.batch([
    db
      .prepare(
        `SELECT s.country, COUNT(DISTINCT s.visitor_id) AS n FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ? AND s.started_at > ? AND s.country IS NOT NULL
           AND (s.started_at > v.first_seen + 43200000 OR v.email IS NOT NULL OR v.user_id IS NOT NULL)
         GROUP BY s.country`,
      )
      .bind(siteId, since),
    // Visits that interacted (bots rarely do), for the fallback when a site has few real readers yet: raw visit
    // counts would let a bot wave decide (enewspf: 2,559 from Sydney against 4,786 from the US).
    db
      .prepare('SELECT country, COUNT(*) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND country IS NOT NULL AND engaged = 1 GROUP BY country')
      .bind(siteId, since),
  ]);
  const rows = new Map<string, { readers: number; sessions: number }>();
  for (const r of readers.results as { country: string; n: number }[]) rows.set(r.country, { readers: r.n, sessions: 0 });
  for (const r of all.results as { country: string; n: number }[]) rows.set(r.country, { readers: rows.get(r.country)?.readers ?? 0, sessions: r.n });
  await db.batch([
    db.prepare('DELETE FROM site_audience WHERE site_id = ?').bind(siteId),
    ...[...rows].map(([country, v]) =>
      db.prepare('INSERT INTO site_audience (site_id, country, readers, sessions) VALUES (?, ?, ?, ?)').bind(siteId, country, v.readers, v.sessions),
    ),
    db
      .prepare('INSERT INTO audience_refresh (site_id, refreshed_at) VALUES (?, ?) ON CONFLICT (site_id) DO UPDATE SET refreshed_at = excluded.refreshed_at')
      .bind(siteId, now),
  ]);
  cache.delete(siteId);
}

/** Hourly: refresh the few sites whose audience is oldest (each about once a day), gently. */
export async function refreshSomeAudiences(db: D1Database, perRun = 3) {
  const due = await db
    .prepare(
      `SELECT s.id FROM sites s LEFT JOIN audience_refresh a ON a.site_id = s.id
       WHERE a.refreshed_at IS NULL OR a.refreshed_at < ? ORDER BY COALESCE(a.refreshed_at, 0) LIMIT ?`,
    )
    .bind(Date.now() - 20 * 3_600_000, perRun)
    .all<{ id: string }>();
  for (const s of due.results) await refreshAudience(db, s.id);
}

type Audience = { readers: Map<string, number>; total: number; top: string | null; topShare: number };
const cache = new Map<string, { at: number; aud: Audience }>();

async function audienceOf(db: D1Database, siteId: string): Promise<Audience> {
  const hit = cache.get(siteId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.aud;
  const r = await db.prepare('SELECT country, readers, sessions FROM site_audience WHERE site_id = ?').bind(siteId).all<{ country: string; readers: number; sessions: number }>();
  const readers = new Map<string, number>();
  let total = 0, all = 0, top: string | null = null, topN = 0;
  for (const x of r.results) {
    readers.set(x.country, x.readers);
    total += x.readers;
    all += x.sessions;
    if (x.sessions > topN) (top = x.country), (topN = x.sessions);
  }
  const aud = { readers, total, top, topShare: all ? topN / all : 0 };
  cache.set(siteId, { at: Date.now(), aud });
  return aud;
}

/**
 * Is a visitor from this country outside the site's audience? With enough real readers: their country has fewer
 * than max(2, 1%) of them. Otherwise, when one country has most of the site's visits that interacted, anywhere else.
 * Unknown: no.
 * Measured: 1.0% of real readers' first visits fall outside and don't then interact and stay 15s; 11% of one-time.
 */
export async function outsideAudience(db: D1Database, siteId: string, country: string | null): Promise<boolean> {
  if (!country) return false;
  const a = await audienceOf(db, siteId);
  if (a.total >= MIN_READERS) return (a.readers.get(country) ?? 0) < Math.max(2, 0.01 * a.total);
  if (a.top && a.topShare >= 0.5) return country !== a.top;
  return false;
}
