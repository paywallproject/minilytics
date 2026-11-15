// Turns a Plausible CSV export (the zip from Site settings → Imports & Exports) into Minilytics' imported
// daily totals. Runs in the browser, so the big file never has to be uploaded in one piece.
//
// Plausible exports daily aggregates, not individual visits, so each output row is "on this day, this
// value of this dimension had N visitors". The dashboard adds them to its reports for days before
// Minilytics started collecting.

import { belongsTo, normalizePath } from './paths';
import { classify, findKnownSource } from './sources';

/** Dimensions an imported row can belong to. `total` is the site-wide daily total. */
export const IMPORT_DIMS = [
  'total',
  'channel',
  'source',
  'campaign',
  'keyword',
  'utm_source',
  'utm_medium',
  'utm_content',
  'country',
  'region',
  'browser',
  'os',
  'device',
  'page',
  'entry_page',
  'goal',
  'exit_link',
] as const;
export type ImportDim = (typeof IMPORT_DIMS)[number];

/** [date (YYYY-MM-DD), dim, label, extra, visitors, visits, pageviews, bounces, duration in seconds] */
export type ImportRow = [string, ImportDim, string | null, string | null, number, number, number, number, number];

export interface ParsedImport {
  rows: ImportRow[];
  dateFrom: string;
  dateTo: string;
  visitors: number;
  pageviews: number;
  /** Plausible files that were read. */
  files: string[];
  /** Pages on other hostnames (copies of the site, translation proxies…) that were left out. */
  skippedPages: number;
}

// ---------- zip

/** Files in a zip, by name. Supports stored and deflated entries (what Plausible produces). */
export async function unzip(data: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  // End of central directory: the last record starting with PK\5\6.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a zip file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflate(raw));
    else throw new Error(`Unsupported compression in ${name}.`);
  }
  return out;
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- csv

/** RFC 4180 CSV → objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1 || r[0])
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- mapping

/** Plausible names → the names Minilytics gives the same browser / OS, so both land in one row. */
const BROWSERS: Record<string, string> = {
  'Microsoft Edge': 'Edge',
  'Samsung Browser': 'Samsung Internet',
  'Yandex Browser': 'Yandex',
  'DuckDuckGo Privacy Browser': 'DuckDuckGo',
  'Opera GX': 'Opera',
  'Opera Touch': 'Opera',
};
const OSES: Record<string, string> = {
  Mac: 'Mac OS',
  'GNU/Linux': 'Linux',
  Ubuntu: 'Linux',
  '(none)': 'Other',
};

const num = (v: string | undefined) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const text = (v: string | undefined, max = 500) => (v && v.trim() ? v.trim().slice(0, max) : null);

function hostOf(referrer: string): string | null {
  const r = referrer.trim();
  if (!r) return null;
  try {
    return new URL(/^[a-z][\w+.-]*:\/\//i.test(r) ? r : `https://${r}`).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Where a Plausible source row came from, classified exactly like a live visit. */
export function classifyPlausibleSource(r: Record<string, string>) {
  const referrerDomain = hostOf(r.referrer ?? '');
  const utmSource = text(r.utm_source, 100);
  const plausibleSource = text(r.source, 100);
  const direct = !plausibleSource || /^direct/i.test(plausibleSource);
  // Plausible only knows a source name for some visits (e.g. "ig" from ?ref=ig): treat it like a ref tag.
  const ref = !referrerDomain && !utmSource && !direct ? plausibleSource : null;
  const c = classify({ referrerDomain, utmSource, utmMedium: text(r.utm_medium, 100), ref });
  // Plausible may know a name Minilytics only sees as a domain (e.g. a Plausible source of "Facebook").
  if (c.source === referrerDomain && plausibleSource) {
    const known = findKnownSource(plausibleSource);
    if (known) return { ...c, source: known.name, channel: known.channel };
  }
  return c;
}

/** The kind of data a Plausible export file holds, from its name (imported_sources_20250305_20261115.csv → sources). */
function kindOf(name: string): string | null {
  const m = /(?:^|\/)imported_([a-z_]+?)_\d{8}_\d{8}\.csv$/.exec(name);
  return m ? m[1] : null;
}

export async function parsePlausibleExport(data: ArrayBuffer, domain: string): Promise<ParsedImport> {
  const files = await unzip(data);
  const byKind = new Map<string, string>();
  for (const [name, content] of files) {
    const kind = kindOf(name);
    if (kind) byKind.set(kind, new TextDecoder().decode(content));
  }
  if (!byKind.has('visitors')) {
    throw new Error("This doesn't look like a Plausible export: imported_visitors_….csv is missing.");
  }
  return mapPlausible(byKind, domain);
}

/** Pure mapping from Plausible CSV text (keyed by kind) to imported rows. */
export function mapPlausible(byKind: Map<string, string>, domain: string): ParsedImport {
  const acc = new Map<string, ImportRow>();
  const add = (date: string, dim: ImportDim, label: string | null, extra: string | null, m: Partial<Record<'v' | 'vi' | 'pv' | 'b' | 'd', number>>) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const key = `${date}\u0000${dim}\u0000${label ?? ''}`;
    let row = acc.get(key);
    if (!row) acc.set(key, (row = [date, dim, label, extra, 0, 0, 0, 0, 0]));
    if (!row[3] && extra) row[3] = extra;
    row[4] += m.v ?? 0;
    row[5] += m.vi ?? 0;
    row[6] += m.pv ?? 0;
    row[7] += m.b ?? 0;
    row[8] += m.d ?? 0;
  };
  const csv = (kind: string) => (byKind.has(kind) ? parseCsv(byKind.get(kind)!) : []);
  const visit = (r: Record<string, string>, visits = r.visits) => ({
    v: num(r.visitors),
    vi: num(visits),
    pv: num(r.pageviews),
    b: num(r.bounces),
    d: num(r.visit_duration),
  });

  let visitors = 0;
  let pageviews = 0;
  let dateFrom = '';
  let dateTo = '';
  for (const r of csv('visitors')) {
    add(r.date, 'total', null, null, visit(r));
    visitors += num(r.visitors);
    pageviews += num(r.pageviews);
    if (!dateFrom || r.date < dateFrom) dateFrom = r.date;
    if (!dateTo || r.date > dateTo) dateTo = r.date;
  }

  for (const r of csv('sources')) {
    const c = classifyPlausibleSource(r);
    const m = visit(r);
    add(r.date, 'channel', c.channel, null, m);
    add(r.date, 'source', c.source, c.referrerDomain, m);
    add(r.date, 'campaign', text(r.utm_campaign, 200), null, m);
    add(r.date, 'keyword', text(r.utm_term, 200), null, m);
    add(r.date, 'utm_source', text(r.utm_source, 100), null, m);
    add(r.date, 'utm_medium', text(r.utm_medium, 100), null, m);
    add(r.date, 'utm_content', text(r.utm_content, 200), null, m);
  }

  let skippedPages = 0;
  for (const r of csv('pages')) {
    // Same rule as live tracking: only the site's own domain and its subdomains count.
    if (r.hostname && !belongsTo(r.hostname, domain)) {
      skippedPages++;
      continue;
    }
    add(r.date, 'page', normalizePath(r.page), null, { v: num(r.visitors), vi: num(r.visits), pv: num(r.pageviews) });
  }

  for (const r of csv('entry_pages')) add(r.date, 'entry_page', normalizePath(r.entry_page), null, visit(r, r.entrances));

  for (const r of csv('locations')) {
    const country = text(r.country, 2)?.toUpperCase() ?? null;
    const m = visit(r);
    add(r.date, 'country', country, null, m);
    const region = text(r.region, 100);
    if (region) add(r.date, 'region', region, country, m);
  }

  for (const r of csv('browsers')) add(r.date, 'browser', BROWSERS[r.browser] ?? text(r.browser, 100) ?? 'Other', null, visit(r));
  for (const r of csv('operating_systems')) {
    add(r.date, 'os', OSES[r.operating_system] ?? text(r.operating_system, 100) ?? 'Other', null, visit(r));
  }
  for (const r of csv('devices')) add(r.date, 'device', text(r.device, 20), null, visit(r));

  for (const r of csv('custom_events')) {
    const events = num(r.events);
    if (r.name === 'Outbound Link: Click') {
      const url = text(r.link_url, 500);
      if (url) add(r.date, 'exit_link', url, null, { v: num(r.visitors), pv: events });
    } else {
      const name = text(r.name, 64);
      if (name) add(r.date, 'goal', name, null, { v: num(r.visitors), pv: events });
    }
  }

  return {
    rows: [...acc.values()],
    dateFrom,
    dateTo,
    visitors,
    pageviews,
    files: [...byKind.keys()].sort(),
    skippedPages,
  };
}
