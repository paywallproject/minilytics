// Set up a client on a Minilytics install: their own login, their site, and (optionally) their Plausible history.
//
//   MINILYTICS_ADMIN_EMAIL=… MINILYTICS_ADMIN_PASSWORD=… npx vite-node scripts/onboard-client.ts -- \
//     --host https://data.example.com --domain client.com --email owner@client.com \
//     --timezone America/New_York [--name "Client"] [--currency USD] [--zip export.zip]
//
// Safe to run again: the account and site are reused (the password is only printed when the account is new),
// and importing again replaces the earlier import. Prints one JSON object on stdout.

import { readFileSync } from 'node:fs';
import { parsePlausibleExport, type ImportRow } from '../src/shared/plausible';

const CHUNK = 5000;

function args() {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2).filter((x) => x !== '--');
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const [k, v] = a[i].slice(2).split('=', 2);
    out[k] = v ?? a[++i] ?? '';
  }
  return out;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const opt = args();
const host = (opt.host ?? '').replace(/\/+$/, '');
const adminEmail = process.env.MINILYTICS_ADMIN_EMAIL ?? '';
const adminPassword = process.env.MINILYTICS_ADMIN_PASSWORD ?? '';
if (!/^https?:\/\//.test(host)) fail('--host is required, e.g. https://data.example.com');
if (!opt.domain || !opt.email || !opt.timezone) fail('--domain, --email and --timezone are required');
if (!adminPassword) fail('Set MINILYTICS_ADMIN_EMAIL and MINILYTICS_ADMIN_PASSWORD');

let cookie = '';
async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(host + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? res.statusText}`);
  return data as T;
}

async function sendChunk(siteId: string, importId: string, rows: ImportRow[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call('POST', `/api/sites/${siteId}/import/${importId}/rows`, { rows });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/** Top values of a dimension over the whole import, with their share of visitors. */
function top(rows: ImportRow[], dim: string, total: number, n = 5) {
  const m = new Map<string, number>();
  for (const r of rows) if (r[1] === dim) m.set(r[2] ?? '(none)', (m.get(r[2] ?? '(none)') ?? 0) + r[4]);
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, visitors]) => ({ label, visitors, share: total ? Math.round((visitors / total) * 1000) / 10 : 0 }));
}

try {
  // Parse first, so a bad zip stops before anything is created.
  let parsed: Awaited<ReturnType<typeof parsePlausibleExport>> | null = null;
  if (opt.zip) {
    const buf = readFileSync(opt.zip);
    parsed = await parsePlausibleExport(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), opt.domain);
  }

  await call('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  const client = await call('POST', '/api/admin/clients', {
    email: opt.email,
    domain: opt.domain,
    name: opt.name || undefined,
    timezone: opt.timezone,
    currency: opt.currency || 'USD',
  });
  const site = client.site;

  let imported = null;
  if (parsed) {
    const started = Date.now();
    const { id } = await call<{ id: string }>('POST', `/api/sites/${site.id}/import`, {
      source: 'plausible',
      date_from: parsed.dateFrom,
      date_to: parsed.dateTo,
      rows: parsed.rows.length,
    });
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      await sendChunk(site.id, id, parsed.rows.slice(i, i + CHUNK));
      process.stderr.write(`\rImporting… ${Math.min(100, Math.round(((i + CHUNK) / parsed.rows.length) * 100))}%`);
    }
    process.stderr.write('\n');
    await call('POST', `/api/sites/${site.id}/import/${id}/finish`);
    imported = {
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      visitors: parsed.visitors,
      pageviews: parsed.pageviews,
      rows: parsed.rows.length,
      files: parsed.files,
      skippedPages: parsed.skippedPages,
      seconds: Math.round((Date.now() - started) / 1000),
      top: {
        countries: top(parsed.rows, 'country', parsed.visitors),
        sources: top(parsed.rows, 'source', parsed.visitors),
        os: top(parsed.rows, 'os', parsed.visitors),
      },
    };
  }

  console.log(
    JSON.stringify(
      {
        dashboard: `${host}/site/${site.id}`,
        login: { url: host, email: client.account.email, password: client.account.password, newAccount: client.account.created },
        site: { id: site.id, name: site.name, domain: site.domain, timezone: site.timezone, currency: site.currency, apiKey: site.api_key, newSite: site.created },
        imported,
      },
      null,
      2,
    ),
  );
} catch (e) {
  fail((e as Error).message);
}
