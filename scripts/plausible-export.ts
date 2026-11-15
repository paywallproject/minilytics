// Download a site's CSV export from a self-hosted Plausible (Community Edition, local export storage).
//
//   PLAUSIBLE_EMAIL=… PLAUSIBLE_PASSWORD=… npx vite-node scripts/plausible-export.ts -- \
//     --host https://plausible.example.com --domain client.com --out /tmp/dir [--fresh]
//
// Uses today's export if Plausible already has one, otherwise clicks "Prepare download" (a LiveView button)
// and waits for the zip. --fresh always prepares a new export. Prints {"file", "filename", "timezone", "generated"}
// on stdout; timezone is the Plausible site's, which the Minilytics site must match.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function args() {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2).filter((x) => x !== '--');
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const [k, v] = a[i].slice(2).split('=', 2);
    out[k] = v ?? (a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : 'true');
  }
  return out;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const opt = args();
const host = (opt.host ?? '').replace(/\/+$/, '');
const domain = (opt.domain ?? '').trim().toLowerCase();
if (!/^https:\/\//.test(host) || !domain || !opt.out) fail('--host (https://…), --domain and --out are required');
if (!process.env.PLAUSIBLE_EMAIL || !process.env.PLAUSIBLE_PASSWORD) fail('Set PLAUSIBLE_EMAIL and PLAUSIBLE_PASSWORD');

const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(host + path, { ...init, redirect: 'manual', headers: { ...(init.headers as object), cookie: cookieHeader() } });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

const csrfOf = (html: string) => /name="_csrf_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? /<meta name="csrf-token" content="([^"]+)"/.exec(html)?.[1];
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function login() {
  const page = await (await get('/login')).text();
  const token = csrfOf(page);
  if (!token) fail('Plausible login page has no CSRF token');
  const res = await get('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf_token: token, email: process.env.PLAUSIBLE_EMAIL!, password: process.env.PLAUSIBLE_PASSWORD! }),
  });
  if (res.status !== 302 || /\/login/.test(res.headers.get('location') ?? '')) fail('Plausible login failed (wrong email or password, or 2FA is on)');
}

async function exportsPage() {
  const res = await get(`/${encodeURIComponent(domain)}/settings/imports-exports`);
  if (res.status === 404) fail(`Plausible has no site ${domain}`);
  if (res.status !== 200) fail(`Plausible imports & exports page returned ${res.status}`);
  const html = await res.text();
  const ready = new RegExp(`href="/${domain.replace(/\./g, '\\.')}/download/export"[^>]*>\\s*([^<\\s]+\\.zip)`).exec(html)?.[1] ?? null;
  return { html, ready };
}

/** Click a LiveView button: join the view over Phoenix's websocket and send the click event. */
async function clickLive(html: string, event: string) {
  const token = /<meta name="csrf-token" content="([^"]+)"/.exec(html)?.[1];
  // The export panel is a nested LiveView with its own session.
  // Other panels on the page (imports) are LiveViews too: take the first one after the "Export Data" heading.
  const view = /<div id="(phx-[^"]+)" data-phx-session="([^"]+)" data-phx-static="([^"]+)"/.exec(html.slice(Math.max(0, html.indexOf('Export Data'))));
  if (!token || !view) fail('Could not find the Plausible export button');
  const [, id, session, stat] = view;
  const url = `${host.replace(/^http/, 'ws')}/live/websocket?_csrf_token=${encodeURIComponent(token)}&vsn=2.0.0`;
  // Node's WebSocket (undici) accepts headers, so the login cookie goes along like in a browser.
  const ws = new (WebSocket as any)(url, { headers: { cookie: cookieHeader(), origin: host } }) as WebSocket;
  const topic = `lv:${id}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Plausible did not answer the export click')), 20_000);
    ws.onerror = () => reject(new Error('Could not connect to Plausible live updates'));
    ws.onopen = () =>
      ws.send(
        JSON.stringify([
          '1',
          '1',
          topic,
          'phx_join',
          { url: `${host}/${domain}/settings/imports-exports`, params: { _csrf_token: token, _mounts: 0 }, session, static: stat },
        ]),
      );
    ws.onmessage = (m) => {
      const [, ref, , ev, payload] = JSON.parse(String(m.data));
      if (ev !== 'phx_reply') return;
      if (payload?.status !== 'ok') return reject(new Error(`Plausible refused: ${JSON.stringify(payload?.response ?? payload)}`));
      if (ref === '1') ws.send(JSON.stringify(['1', '2', topic, 'event', { type: 'click', event, value: {} }]));
      else if (ref === '2') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  ws.close();
}

/** The Plausible site's timezone (its dates are in this timezone). */
async function timezone() {
  const html = await (await get(`/${encodeURIComponent(domain)}/settings/general`)).text();
  return /<option[^>]*\boffset="[^"]*"[^>]*\bselected[^>]*value="([^"]+)"/.exec(html)?.[1] ?? /<option[^>]*\bselected[^>]*\boffset="[^"]*"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? null;
}

try {
  await login();
  const tz = await timezone();
  let { html, ready } = await exportsPage();
  const fresh = opt.fresh === 'true' || !ready || !ready.includes(`_${today()}.zip`);
  let generated = false;
  if (fresh) {
    if (ready) {
      // Plausible keeps one export per site: delete the old one first, as its trash button does.
      await clickLive(html, 'delete');
      ({ html } = await exportsPage());
    }
    await clickLive(html, 'export');
    generated = true;
    ready = null;
    const started = Date.now();
    while (!ready) {
      if (Date.now() - started > 15 * 60_000) fail('The Plausible export took over 15 minutes');
      await new Promise((r) => setTimeout(r, 5000));
      ({ ready } = await exportsPage());
      process.stderr.write(`\rWaiting for Plausible's export… ${Math.round((Date.now() - started) / 1000)}s`);
    }
    process.stderr.write('\n');
  }
  const res = await get(`/${encodeURIComponent(domain)}/download/export`);
  if (res.status !== 200) fail(`Download returned ${res.status}`);
  mkdirSync(opt.out, { recursive: true });
  const file = join(opt.out, ready!);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(JSON.stringify({ file, filename: ready, timezone: tz, generated }, null, 2));
} catch (e) {
  fail((e as Error).message);
}
