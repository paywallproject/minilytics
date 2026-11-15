import type { Context } from 'hono';
import { IMPORT_DIMS, type ImportDim } from '../shared/plausible';
import type { AppEnv, Site } from './env';
import { randomId } from './lib/crypto';
import { addDays, dayOf, parseDay, type Granularity, type Range } from './lib/time';

/** The site's finished import, and the first day Minilytics itself has data for. */
export interface SiteImport {
  id: string;
  dateFrom: string;
  dateTo: string;
  /** First day with a real Minilytics visit: imported data is only used before it, so no day counts twice. */
  cutoff: string | null;
}

export async function loadImport(db: D1Database, site: Pick<Site, 'id' | 'timezone'>): Promise<SiteImport | null> {
  const row = await db
    .prepare(
      `SELECT i.id, i.date_from, i.date_to, (SELECT MIN(started_at) FROM sessions WHERE site_id = ?) AS first_session
       FROM imports i WHERE i.site_id = ? AND i.status = 'done' ORDER BY i.created_at DESC LIMIT 1`,
    )
    .bind(site.id, site.id)
    .first<{ id: string; date_from: string; date_to: string; first_session: number | null }>()
    // Before migration 0011 is applied the table doesn't exist: the dashboard must keep working without imports.
    .catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    cutoff: row.first_session ? dayOf(row.first_session, site.timezone) : null,
  };
}

/** The imported days (inclusive) that fall inside [from, to), or null when none do. Only whole days count. */
export function importedDays(imp: SiteImport, from: number, to: number, tz: string): { first: string; last: string } | null {
  let first = dayOf(from, tz);
  if ((parseDay(first, tz) ?? from) < from) first = addDays(first, 1);
  let last = dayOf(to - 1, tz);
  if (first < imp.dateFrom) first = imp.dateFrom;
  if (last > imp.dateTo) last = imp.dateTo;
  if (imp.cutoff && last >= imp.cutoff) last = addDays(imp.cutoff, -1);
  return first <= last ? { first, last } : null;
}

/** Bucket label for an imported day, matching bucketSql. Imported data is daily, so hourly charts put it at midnight. */
export function importedBucketSql(g: Granularity): string {
  switch (g) {
    case 'hour':
      return `date || 'T00:00'`;
    case 'day':
      return 'date';
    case 'week':
      return `date(date, 'weekday 0', '-6 days')`;
    case 'month':
      return 'substr(date, 1, 7)';
  }
}

export interface ImportedTotals {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  /** Sum of visit durations, ms. */
  duration: number;
}

const EMPTY: ImportedTotals = { visitors: 0, sessions: 0, pageviews: 0, bounces: 0, duration: 0 };

/** Site-wide totals for imported days in [from, to). */
export function importedTotalsStmt(db: D1Database, imp: SiteImport | null, range: Pick<Range, 'from' | 'to'>, tz: string) {
  const days = imp && importedDays(imp, range.from, range.to, tz);
  if (!imp || !days) return null;
  return db
    .prepare(
      `SELECT COALESCE(SUM(visitors), 0) AS visitors, COALESCE(SUM(visits), 0) AS sessions, COALESCE(SUM(pageviews), 0) AS pageviews,
              COALESCE(SUM(bounces), 0) AS bounces, COALESCE(SUM(duration), 0) * 1000 AS duration
       FROM imported_stats WHERE import_id = ? AND dim = 'total' AND date >= ? AND date <= ?`,
    )
    .bind(imp.id, days.first, days.last);
}

export const importedTotals = (r: D1Result | undefined): ImportedTotals => (r?.results[0] as ImportedTotals | undefined) ?? EMPTY;

/** Dashboard dimension → imported dimension. City, hostname, ref and exit page have no imported data. */
const BREAKDOWN_DIMS: Record<string, ImportDim> = {
  channel: 'channel',
  source: 'source',
  campaign: 'campaign',
  keyword: 'keyword',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_content: 'utm_content',
  country: 'country',
  region: 'region',
  browser: 'browser',
  os: 'os',
  device: 'device',
  page: 'page',
  entry_page: 'entry_page',
  goal: 'goal',
  exit_link: 'exit_link',
};

export async function importedBreakdown(
  db: D1Database,
  imp: SiteImport | null,
  range: Pick<Range, 'from' | 'to'>,
  tz: string,
  dim: string,
  limit: number,
): Promise<{ label: string | null; visitors: number; pageviews: number; extra: string | null }[]> {
  const idim = BREAKDOWN_DIMS[dim];
  const days = imp && importedDays(imp, range.from, range.to, tz);
  if (!imp || !days || !idim) return [];
  const res = await db
    .prepare(
      `SELECT label, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews, MAX(extra) AS extra
       FROM imported_stats WHERE import_id = ? AND dim = ? AND date >= ? AND date <= ?
       GROUP BY label ORDER BY visitors DESC LIMIT ${Math.max(1, Math.min(500, limit))}`,
    )
    .bind(imp.id, idim, days.first, days.last)
    .all<{ label: string | null; visitors: number; pageviews: number; extra: string | null }>();
  return res.results;
}

// ---------- import API (owner only)

const MAX_ROWS_PER_REQUEST = 5000;
const ROWS_PER_STATEMENT = 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIMS = new Set<string>(IMPORT_DIMS);

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 2 ** 40) : 0);
const label = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** Check one uploaded row and return it in the stored shape, or null if it's malformed. */
export function cleanRow(r: unknown): unknown[] | null {
  if (!Array.isArray(r) || r.length !== 9) return null;
  const [date, dim, l, extra, ...m] = r;
  if (typeof date !== 'string' || !DAY_RE.test(date) || typeof dim !== 'string' || !DIMS.has(dim)) return null;
  return [date, dim, label(l, 500), label(extra, 255), ...m.map(count)];
}

/** Remove every import of the site except `keep`, in chunks so a large one doesn't hit D1's time limit. */
export async function clearImports(db: D1Database, siteId: string, keep = '') {
  const ids = await db.prepare('SELECT id FROM imports WHERE site_id = ? AND id != ?').bind(siteId, keep).all<{ id: string }>();
  for (const { id } of ids.results) {
    for (;;) {
      const r = await db
        .prepare('DELETE FROM imported_stats WHERE rowid IN (SELECT rowid FROM imported_stats WHERE import_id = ? LIMIT 20000)')
        .bind(id)
        .run();
      if ((r.meta.changes ?? 0) < 20000) break;
    }
    await db.prepare('DELETE FROM imports WHERE id = ?').bind(id).run();
  }
}

const IMPORT_COLS = 'id, source, status, date_from, date_to, rows_total, rows_done, created_at';

/** GET /api/sites/:id/import: the latest import, finished or not. */
export async function getImport(c: Context<AppEnv>) {
  const row = await c.env.DB.prepare(`SELECT ${IMPORT_COLS} FROM imports WHERE site_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(c.get('site').id)
    .first()
    .catch(() => null);
  return c.json(row ?? null);
}

/** POST /api/sites/:id/import: start an import. The previous one stays visible until this one finishes. */
export async function startImport(c: Context<AppEnv>) {
  const site = c.get('site');
  const b = await c.req.json<{ source?: string; date_from?: string; date_to?: string; rows?: number }>().catch(() => ({}) as Record<string, never>);
  if (b.source !== 'plausible') return c.json({ error: 'Only Plausible exports can be imported.' }, 400);
  if (!b.date_from || !b.date_to || !DAY_RE.test(b.date_from) || !DAY_RE.test(b.date_to) || b.date_from > b.date_to) {
    return c.json({ error: 'The export has no dates.' }, 400);
  }
  // Unfinished uploads from earlier attempts.
  const stale = await c.env.DB.prepare(`SELECT id FROM imports WHERE site_id = ? AND status != 'done'`).bind(site.id).all<{ id: string }>();
  const done = await c.env.DB.prepare(`SELECT id FROM imports WHERE site_id = ? AND status = 'done'`).bind(site.id).all<{ id: string }>();
  if (stale.results.length) await clearImports(c.env.DB, site.id, done.results[0]?.id ?? '');
  const id = randomId(10);
  await c.env.DB.prepare(
    `INSERT INTO imports (id, site_id, source, status, date_from, date_to, rows_total, rows_done, created_at)
     VALUES (?, ?, 'plausible', 'importing', ?, ?, ?, 0, ?)`,
  )
    .bind(id, site.id, b.date_from, b.date_to, count(b.rows), Date.now())
    .run();
  return c.json({ id });
}

/** POST /api/sites/:id/import/:iid/rows: one chunk of rows. */
export async function addImportRows(c: Context<AppEnv>) {
  const site = c.get('site');
  const iid = c.req.param('iid');
  const imp = await c.env.DB.prepare(`SELECT id FROM imports WHERE id = ? AND site_id = ? AND status = 'importing'`).bind(iid, site.id).first();
  if (!imp) return c.json({ error: 'import not found' }, 404);
  const b = await c.req.json<{ rows?: unknown[] }>().catch(() => ({}) as { rows?: unknown[] });
  if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS_PER_REQUEST) {
    return c.json({ error: `Send between 1 and ${MAX_ROWS_PER_REQUEST} rows.` }, 400);
  }
  const rows = b.rows.map(cleanRow);
  if (rows.some((r) => !r)) return c.json({ error: 'Malformed row.' }, 400);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    // One JSON parameter per statement: D1 allows only 100 bound parameters.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO imported_stats (import_id, date, dim, label, extra, visitors, visits, pageviews, bounces, duration)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
                json_extract(value, '$[8]')
         FROM json_each(?)`,
      ).bind(iid, JSON.stringify(rows.slice(i, i + ROWS_PER_STATEMENT))),
    );
  }
  stmts.push(c.env.DB.prepare('UPDATE imports SET rows_done = rows_done + ? WHERE id = ?').bind(rows.length, iid));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
}

/** POST /api/sites/:id/import/:iid/finish: show the new import and drop the old one. */
export async function finishImport(c: Context<AppEnv>) {
  const site = c.get('site');
  const iid = c.req.param('iid');
  const r = await c.env.DB.prepare(`UPDATE imports SET status = 'done' WHERE id = ? AND site_id = ? AND status = 'importing'`).bind(iid, site.id).run();
  if (!r.meta.changes) return c.json({ error: 'import not found' }, 404);
  await clearImports(c.env.DB, site.id, iid);
  return c.json({ ok: true });
}

/** DELETE /api/sites/:id/import: remove imported data. */
export async function deleteImport(c: Context<AppEnv>) {
  await clearImports(c.env.DB, c.get('site').id);
  return c.json({ ok: true });
}
