import type { Ctx } from './stats';

/**
 * Admin check of the proxy-bot hold (lib/hold.ts): how many new visits were held, how many turned out to be people,
 * and what the ones that weren't counted looked like, to spot real readers among them.
 */
export async function heldReport(ctx: Ctx) {
  const { db, site, range } = ctx;
  const where = `site_id = ? AND ts >= ? AND ts < ? AND reason != 'early_goal'`;
  const bind = [site.id, range.from, range.to];
  const top = (expr: string) =>
    db
      .prepare(`SELECT ${expr} AS label, COUNT(*) AS n FROM held_visits WHERE ${where} AND released_at IS NULL GROUP BY 1 ORDER BY n DESC LIMIT 15`)
      .bind(...bind);
  const [totals, network, city, os, page, visible, engaged, recent, releasedHow, cameBack, botd] = await db.batch([
    db
      .prepare(`SELECT reason, released_at IS NOT NULL AS counted, COUNT(*) AS n FROM held_visits WHERE ${where} GROUP BY 1, 2 ORDER BY n DESC`)
      .bind(...bind),
    top(`json_extract(meta, '$.network')`),
    top(`json_extract(meta, '$.city') || ', ' || json_extract(meta, '$.country')`),
    top(`json_extract(meta, '$.os') || ' / ' || json_extract(meta, '$.browser') || ' / ' || json_extract(meta, '$.device')`),
    top(`json_extract(body, '$.u')`),
    top(`CASE WHEN visible = 0 THEN '0s' WHEN visible < 3000 THEN 'under 3s' WHEN visible < 15000 THEN '3-15s' ELSE '15s+' END`),
    top(`CASE WHEN engaged = 0 THEN 'no interaction' ELSE COALESCE(engage_kind, '?') || ' at ' ||
      CASE WHEN engage_ms IS NULL THEN '?' WHEN engage_ms < 500 THEN 'under 0.5s' WHEN engage_ms < 2000 THEN '0.5-2s' ELSE '2s+' END END`),
    db
      .prepare(
        `SELECT ts, reason, signals, visible, engaged, engage_kind, engage_ms, meta, json_extract(body, '$.u') AS url
         FROM held_visits WHERE ${where} AND released_at IS NULL ORDER BY ts DESC LIMIT 50`,
      )
      .bind(...bind),
    db
      .prepare(
        `SELECT CASE WHEN engaged = 1 THEN 'interacted' WHEN visible > 0 THEN 'time on screen' ELSE 'second page, login or click out' END AS label,
           COUNT(*) AS n FROM held_visits WHERE ${where} AND released_at IS NOT NULL GROUP BY 1 ORDER BY n DESC`,
      )
      .bind(...bind),
    // Self-check: not counted, but the same browser came back later and was counted then (a real reader whose first
    // visit the hold missed; these crawlers don't come back).
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM held_visits h
         WHERE h.site_id = ? AND h.ts >= ? AND h.ts < ? AND h.reason != 'early_goal' AND h.released_at IS NULL
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.site_id = h.site_id AND s.visitor_id = json_extract(h.body, '$.vid') AND s.started_at > h.ts)`,
      )
      .bind(...bind),
    // The open-source bot detector's verdict, for held visits counted after all and not counted.
    db
      .prepare(
        `SELECT released_at IS NOT NULL AS counted, COALESCE(botd, 'not run') AS label, COUNT(*) AS n FROM held_visits WHERE ${where}
         GROUP BY 1, 2 ORDER BY n DESC`,
      )
      .bind(...bind),
  ]);
  return {
    botd: botd.results,
    totals: totals.results,
    cameBack: (cameBack.results[0] as { n: number } | undefined)?.n ?? 0,
    releasedHow: releasedHow.results,
    notCounted: { network: network.results, city: city.results, os: os.results, page: page.results, visible: visible.results, engaged: engaged.results },
    recent: (recent.results as { meta: string | null }[]).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })),
  };
}

/**
 * Admin research: first visits of new visitors in [from, to), grouped by what the hold can see, with whether the
 * visitor came back later or is a known reader (logged in or paid). People come back; these crawlers never do,
 * so "came back" scores any rule's cost in real readers. Read-only, aggregate counts only.
 */
export async function botStudy(db: D1Database, from: number, to: number, domain?: string) {
  const sites = (await db.prepare('SELECT id, domain FROM sites WHERE ? IS NULL OR domain = ?').bind(domain ?? null, domain ?? null).all<{ id: string; domain: string }>()).results;
  const out: Record<string, unknown[]> = {};
  for (const site of sites) {
    const r = await db
      .prepare(
        `SELECT s.country, s.region, s.channel, s.source = 'Google' AS google, s.device, s.os, s.browser, s.engaged,
           CASE WHEN s.duration = 0 THEN '0' WHEN s.duration < 3000 THEN '1-3' WHEN s.duration < 15000 THEN '3-15' ELSE '15+' END AS dur,
           COALESCE(s.signals, '') AS signals, s.pageviews > 1 AS multi, s.goals > 0 AS goals,
           s.entry_page GLOB '*/page/[0-9][0-9]*' AS deep, s.entry_page = '/' AS home,
           CASE WHEN s.entry_page GLOB '/[12][09][0-9][0-9]/*' THEN substr(s.entry_page, 2, 4) END AS year,
           EXISTS (SELECT 1 FROM sessions s2 WHERE s2.site_id = s.site_id AND s2.visitor_id = s.visitor_id AND s2.started_at > s.started_at + 1800000) AS returned,
           (v.email IS NOT NULL OR v.user_id IS NOT NULL OR v.id IN (SELECT visitor_id FROM payments WHERE site_id = ? AND visitor_id IS NOT NULL)) AS known,
           COUNT(*) AS n
         FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ? AND s.started_at - v.first_seen < 60000
         GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17`,
      )
      .bind(site.id, site.id, from, to)
      .all();
    if (r.results.length) out[site.domain] = r.results;
  }
  return out;
}
