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
  const [totals, network, city, os, page, visible, engaged, recent, releasedHow] = await db.batch([
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
        `SELECT CASE WHEN engaged = 1 AND visible >= 3000 THEN 'interacted + 3s' WHEN visible >= 15000 THEN '15s on screen' ELSE 'login or click out' END AS label,
           COUNT(*) AS n FROM held_visits WHERE ${where} AND released_at IS NOT NULL GROUP BY 1 ORDER BY n DESC`,
      )
      .bind(...bind),
  ]);
  return {
    totals: totals.results,
    releasedHow: releasedHow.results,
    notCounted: { network: network.results, city: city.results, os: os.results, page: page.results, visible: visible.results, engaged: engaged.results },
    recent: (recent.results as { meta: string | null }[]).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })),
  };
}
