import type { Context } from 'hono';
import { belongsTo, normalizePath, stripWww } from '../shared/paths';
import { classify } from '../shared/sources';
import { siteOwnerActive } from './auth';
import { getSite, type AppEnv, type Site } from './env';
import { isOwnerVisit } from './owner';
import { isHostingAsn } from './lib/datacenter';
import { botSignals } from './lib/signals';
import { holdReason, releasedBy, releasedByEvent, releasedByPage } from './lib/hold';
import { inHomeRegion, outsideAudience } from './audience';
import { isBot, isSpamReferrer, parseUA } from './lib/ua';
import { creditedSessionSql, dodoProductOfLink, firstTouchSessionSql, learnDodoProducts } from './payments';

const TYPES = new Set(['pageview', 'goal', 'outbound', 'ping', 'identify', 'engage', 'botd']);
const MAX_PING_MS = 10 * 60_000;

interface Payload {
  w: string;
  t: string;
  u: string;
  r?: string;
  vid: string;
  sid: string;
  sw?: number;
  n?: string;
  p?: Record<string, unknown>;
  d?: number;
  a?: string;
  /** Tracker version (absent before the Direct-visit hold). */
  v?: number;
  /** The browser's timezone (pageviews only). */
  tz?: string;
}

const clip = (s: unknown, n = 255): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

export { belongsTo, normalizePath };

export async function handleEvent(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.body(null, 413);
  let body: Payload;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  if (!body || !isId(body.w) || !TYPES.has(body.t) || !isId(body.vid) || !isId(body.sid)) return c.body(null, 400);

  const ua = c.req.header('user-agent') ?? '';
  if (isBot(ua) || unrecognised(ua) || fromHostingNetwork(c) || isSpamReferrer(body.r)) return c.body(null, 202);

  const site = await getSite(c.env.DB, body.w);
  if (!site) return c.body(null, 404);
  // Hosted mode: stop recording when the owner's plan has ended (quietly, so their site never shows errors).
  if (!siteOwnerActive(c.env, site)) return c.body(null, 202);

  let url: URL;
  try {
    url = new URL(body.u);
  } catch {
    return c.body(null, 400);
  }
  // Only accept data for the site's own domain, so nobody can pollute your stats from elsewhere.
  if (!belongsTo(url.hostname, site.domain)) return c.body(null, 403);
  // Owners checking their own site would otherwise show up as visitors and "online".
  if (await isOwnerVisit(c, site)) return c.body(null, 202);

  const now = Date.now();
  const direct = !isProxied(c);
  const signals =
    body.t === 'pageview'
      ? botSignals({
          ua,
          secChUa: c.req.header('sec-ch-ua') ?? null,
          browserTz: body.tz,
          ipTz: direct ? ((cfOf(c)?.timezone as string | undefined) ?? null) : (c.req.header('x-vercel-ip-timezone') ?? null),
          direct,
          now,
        })
      : [];
  if (body.t === 'pageview' && body.v === undefined) signals.push('old_script');
  const db = c.env.DB;

  // Fingerprint's open-source bot detector (BotD) ran in the browser: record its verdict on the visit, whether it was
  // counted or held. Measuring only: it doesn't change what's counted.
  if (body.t === 'botd') {
    const p = body.p ?? {};
    const verdict = p.bot ? (typeof p.k === 'string' && /^[a-z_]{2,30}$/.test(p.k) ? p.k : 'bot') : 'human';
    await db.batch([
      db.prepare('UPDATE sessions SET botd = ? WHERE site_id = ? AND id = ?').bind(verdict, site.id, body.sid),
      db.prepare('UPDATE held_visits SET botd = ? WHERE site_id = ? AND session_id = ?').bind(verdict, site.id, body.sid),
    ]);
    return c.body(null, 202);
  }

  // The hold (lib/hold.ts): a brand-new visitor's first visit waits for a sign that someone saw the page.
  const engage = engageOf(body);
  if (body.t === 'pageview') {
    const [ses, vis, hv] = await db.batch([
      db.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, body.sid),
      db.prepare('SELECT 1 FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, body.vid),
      db
        .prepare(
          `SELECT ts, body, signals, queued, visible, engaged, engage_kind, engage_ms, reason, json_extract(meta, '$.device') AS device
           FROM held_visits WHERE site_id = ? AND session_id = ? AND released_at IS NULL`,
        )
        .bind(site.id, body.sid),
    ]);
    const open = hv.results[0] as HeldRow | undefined;
    if (open && open.reason !== EARLY) {
      // A further page in a held visit. A light hold counts it (people click through, these crawlers load one page);
      // otherwise it's still held, and the page is kept so it's recorded if the visit is counted later (a reader's
      // second page can arrive just before the report from the first page that counts the visit).
      if (!releasedByPage(open.reason, open.engaged)) {
        await queueGoal(db, site, body, now, open.queued);
        return c.body(null, 202);
      }
      await release(db, site, open, ua, geoOf(c), now);
      await ingest(db, site, body, url, ua, geoOf(c), now, signals.join(',') || null);
      return c.body(null, 202);
    }
    const { device, os } = parseUA(ua, Number(body.sw) || undefined);
    const brandNew = !ses.results.length && !vis.results.length;
    const geo = geoOf(c);
    const outside = brandNew && (await outsideAudience(db, site.id, geo.country));
    const far = brandNew && device === 'Desktop' && !(await inHomeRegion(db, site.id, geo.country, geo.region));
    const reason = holdReason({ url, signals, device, os, outside, far });
    if (reason && brandNew) {
      // Goals that arrived before this pageview (see below) stay queued with it.
      await db
        .prepare(
          `INSERT INTO held_visits (site_id, session_id, ts, body, signals, reason, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (site_id, session_id) DO UPDATE SET ts = excluded.ts, body = excluded.body, signals = excluded.signals,
             reason = excluded.reason, meta = excluded.meta`,
        )
        .bind(site.id, body.sid, now, raw, signals.join(',') || null, reason, heldMeta(ua, body, geoOf(c)))
        .run();
      // An interaction that arrived before this pageview (see below) may already be enough.
      if (open?.engaged) {
        const row = { ...open, reason, device, ts: now, body: raw, signals: signals.join(',') || null };
        if (releasedBy(row)) await release(db, site, row, ua, geoOf(c), now);
      }
      return c.body(null, 202);
    }
    if (open) {
      // Not held after all: record the pageview, then what came before it (goals, an interaction).
      await db.prepare('DELETE FROM held_visits WHERE site_id = ? AND session_id = ?').bind(site.id, body.sid).run();
      await ingest(db, site, body, url, ua, geoOf(c), now, signals.join(',') || null);
      for (const q of queuedOf(open.queued)) await ingest(db, site, q.body, new URL(q.body.u), ua, geoOf(c), q.ts);
      if (open.engaged) await ingest(db, site, { ...body, t: 'engage', p: { k: open.engage_kind, ms: open.engage_ms } }, url, ua, geoOf(c), now);
      return c.body(null, 202);
    }
  } else if (body.t === 'ping') {
    // Visible time on a held page: a reader who stays on it (even without touching anything) is released.
    const ms = Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0)));
    const act = activityOf(body);
    const ses = await db
      .prepare(
        `UPDATE sessions SET duration = duration + ?, last_seen_at = ?, ${ACT_SET} WHERE site_id = ? AND id = ?`,
      )
      .bind(ms, now, act.events, act.secs, site.id, body.sid)
      .run();
    if (ses.meta.changes) return c.body(null, 202);
    const held = await db
      .prepare(
        `UPDATE held_visits SET visible = visible + ?, ${ACT_SET} WHERE site_id = ? AND session_id = ? AND released_at IS NULL AND reason != ?
         RETURNING ts, body, signals, queued, visible, engaged, engage_kind, engage_ms, reason, json_extract(meta, '$.device') AS device`,
      )
      .bind(ms, act.events, act.secs, site.id, body.sid, EARLY)
      .first<HeldRow>();
    if (held && releasedBy(held) && (await release(db, site, held, ua, geoOf(c), now))) {
      await ingest(db, site, { ...body, d: held.visible }, url, ua, geoOf(c), now);
    }
    return c.body(null, 202);
  } else {
    const held = await db
      .prepare(
        `SELECT ts, body, signals, queued, visible, engaged, engage_kind, engage_ms, reason, json_extract(meta, '$.device') AS device
         FROM held_visits WHERE site_id = ? AND session_id = ? AND released_at IS NULL`,
      )
      .bind(site.id, body.sid)
      .first<HeldRow>();
    if (held?.reason === EARLY) {
      // Its pageview hasn't arrived yet: keep further goals and the first interaction with it.
      if (body.t === 'goal') {
        await queueGoal(db, site, body, now, held.queued);
        return c.body(null, 202);
      }
      if (body.t === 'engage') {
        await db
          .prepare('UPDATE held_visits SET engaged = 1, engage_kind = COALESCE(engage_kind, ?), engage_ms = COALESCE(engage_ms, ?) WHERE site_id = ? AND session_id = ?')
          .bind(engage.kind, engage.ms, site.id, body.sid)
          .run();
        return c.body(null, 202);
      }
    } else if (held && body.t === 'engage') {
      // Remember it. A light hold counts it now; a strict one together with a few seconds on screen (a later ping).
      const h = { ...held, engaged: 1, engage_kind: engage.kind, engage_ms: engage.ms };
      if (!releasedBy(h)) {
        await db
          .prepare('UPDATE held_visits SET engaged = 1, engage_kind = ?, engage_ms = ? WHERE site_id = ? AND session_id = ?')
          .bind(engage.kind, engage.ms, site.id, body.sid)
          .run();
        return c.body(null, 202);
      }
      if (await release(db, site, h, ua, geoOf(c), now)) await ingest(db, site, { ...body, t: 'ping', d: held.visible }, url, ua, geoOf(c), now);
      return c.body(null, 202);
    } else if (held) {
      if (!releasedByEvent(held.reason, body.t)) {
        // e.g. "paywall shown" fired on load: not a sign of a person. Keep it in case the visit is released.
        if (body.t === 'goal') await queueGoal(db, site, body, now, held.queued);
        return c.body(null, 202);
      }
      // A person after all (logged in, or clicked out): record the held pageview and goals, then this event.
      await release(db, site, held, ua, geoOf(c), now);
    } else if ((body.t === 'goal' || body.t === 'engage') && !(await db.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, body.sid).first())) {
      // A goal or interaction before its visit's first pageview: sites fire "paywall shown" early (the enewspf
      // crawler's arrives first), and on a computer the mouse often moves as the page loads, so the interaction can
      // overtake the pageview. Keep it until the pageview arrives (which decides whether the visit is held); before
      // this, such interactions were lost, which made real readers look like they never touched the page.
      const isGoal = body.t === 'goal';
      await db
        .prepare(
          `INSERT INTO held_visits (site_id, session_id, ts, body, signals, reason, queued, engaged, engage_kind, engage_ms)
           VALUES (?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?)
           ON CONFLICT (site_id, session_id) DO NOTHING`,
        )
        .bind(site.id, body.sid, now, EARLY, isGoal ? JSON.stringify([{ ts: now, body }]) : null, isGoal ? 0 : 1, engage.kind, engage.ms)
        .run();
      return c.body(null, 202);
    }
  }

  await ingest(db, site, body, url, ua, geoOf(c), now, signals.join(',') || null);
  return c.body(null, 202);
}

/** What a held visit looked like, for the admin check (the visit itself isn't stored unless it's released). */
function heldMeta(ua: string, body: Payload, geo: Geo): string {
  const { browser, os, device } = parseUA(ua, Number(body.sw) || undefined);
  return JSON.stringify({ browser, os, device, country: geo.country, region: geo.region, city: geo.city, network: geo.network });
}

/** Marks a goal-only row waiting for its pageview. */
const EARLY = 'early_goal';

interface HeldRow {
  reason: string;
  device?: string | null;
  ts: number;
  body: string;
  signals: string | null;
  queued: string | null;
  visible: number;
  engaged: number;
  engage_kind: string | null;
  engage_ms: number | null;
}

const queuedOf = (q: string | null) => (q ? JSON.parse(q) : []) as { ts: number; body: Payload }[];

/** Activity counts from an early ping ("events.seconds"), or nulls. */
function activityOf(body: Payload): { events: number | null; secs: number | null } {
  const m = typeof body.a === 'string' ? body.a.match(/^(\d{1,3})\.(\d{1,4})$/) : null;
  return m ? { events: Number(m[1]), secs: Number(m[2]) } : { events: null, secs: null };
}
/** Keeps the largest counts seen (the tracker's counts only grow); leaves them alone when a ping has none. */
const ACT_SET = `act_events = NULLIF(MAX(COALESCE(act_events, -1), COALESCE(?, -1)), -1),
  act_secs = NULLIF(MAX(COALESCE(act_secs, -1), COALESCE(?, -1)), -1)`;

/** Keeps an event (a goal, or a further page) with a held visit, to record if it's counted. */
async function queueGoal(db: D1Database, site: Site, body: Payload, now: number, queued: string | null) {
  const q = queuedOf(queued);
  if (q.length >= 10) return false;
  q.push({ ts: now, body });
  await db.prepare('UPDATE held_visits SET queued = ? WHERE site_id = ? AND session_id = ?').bind(JSON.stringify(q), site.id, body.sid).run();
  return true;
}

/** The first interaction the tracker reports: its kind and how long after the page started loading it came. */
function engageOf(body: Payload): { kind: string | null; ms: number | null } {
  if (body.t !== 'engage' || !body.p) return { kind: null, ms: null };
  const k = typeof body.p.k === 'string' && /^[a-z]{3,20}$/.test(body.p.k) ? body.p.k : null;
  // On-screen time before the interaction when the tracker sends it (time in another tab or app doesn't count),
  // otherwise time since the page started loading.
  const ms = Number(body.p.v ?? body.p.ms);
  return { kind: k, ms: Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), 86_400_000) : null };
}

/**
 * A held visit turned out to be a person: record its pageview, any goals it fired and its interaction, as they
 * happened. Returns false if another event released it first.
 */
async function release(db: D1Database, site: Site, held: HeldRow, ua: string, geo: Geo, now: number): Promise<boolean> {
  const first = JSON.parse(held.body) as Payload;
  // Only one event may release it (two can arrive together); the row stays a week for checking.
  const upd = await db
    .prepare('UPDATE held_visits SET released_at = ? WHERE site_id = ? AND session_id = ? AND released_at IS NULL')
    .bind(now, site.id, first.sid)
    .run();
  if (!upd.meta.changes) return false;
  await ingest(db, site, first, new URL(first.u), ua, geo, held.ts, held.signals);
  // Carry the bot detector's verdict and the activity counts over from the held visit.
  await db
    .prepare(
      `UPDATE sessions SET (botd, act_events, act_secs) = (SELECT COALESCE(sessions.botd, h.botd), h.act_events, h.act_secs
         FROM held_visits h WHERE h.site_id = ? AND h.session_id = ?) WHERE site_id = ? AND id = ?`,
    )
    .bind(site.id, first.sid, site.id, first.sid)
    .run();
  for (const q of queuedOf(held.queued)) await ingest(db, site, q.body, new URL(q.body.u), ua, geo, q.ts);
  if (held.engaged) {
    await ingest(db, site, { ...first, t: 'engage', p: { k: held.engage_kind, ms: held.engage_ms } }, new URL(first.u), ua, geo, now);
  }
  return true;
}

/**
 * Scrapers and stealth headless browsers run the script with a normal-looking Chrome user agent, but from
 * cloud servers rather than people's ISPs. Skipped when the script is proxied through the site's own
 * server, because then we see the proxy's network (often AWS), not the visitor's.
 */
function fromHostingNetwork(c: Context<AppEnv>): boolean {
  return !isProxied(c) && isHostingAsn(cfOf(c)?.asn);
}

/**
 * Every real browser names itself and its OS in the user agent. When we can recognise neither, it's a script or
 * crawler with a made-up user agent that isBot doesn't know (e.g. 671 such "visitors" from Sydney on one site in a day).
 */
function unrecognised(ua: string): boolean {
  const { browser, os } = parseUA(ua);
  return browser === 'Other' && os === 'Other';
}

/** True when the event reached us through the site's own server rather than straight from the browser. */
function isProxied(c: Context<AppEnv>): boolean {
  if (c.req.header('x-vercel-ip-country')) return true;
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return !!fwd && fwd !== c.req.header('cf-connecting-ip');
}

const cfOf = (c: Context<AppEnv>) => (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  /** "AS<number> <owner>", or null when proxied. */
  network: string | null;
}

/** City-level coordinates, rounded to 2 decimals (~1 km) so no precise location is ever stored. */
function coord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 100) / 100 : null;
}

/**
 * Visitor location. When the script is proxied through your own domain (to dodge ad blockers),
 * Cloudflare sees the proxy's location, so trust the proxy's geo headers when present (Vercel sets these).
 */
function geoOf(c: Context<AppEnv>): Geo {
  const h = (n: string) => {
    const v = c.req.header(n);
    try {
      return v ? decodeURIComponent(v) : null;
    } catch {
      return v ?? null;
    }
  };
  if (h('x-vercel-ip-country')) {
    return {
      country: h('x-vercel-ip-country'),
      region: h('x-vercel-ip-country-region'),
      city: h('x-vercel-ip-city'),
      lat: coord(h('x-vercel-ip-latitude'), 90),
      lon: coord(h('x-vercel-ip-longitude'), 180),
      network: null,
    };
  }
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: (cf?.country as string) ?? null,
    region: (cf?.region as string) ?? null,
    city: (cf?.city as string) ?? null,
    lat: coord(cf?.latitude, 90),
    lon: coord(cf?.longitude, 180),
    network: !isProxied(c) && typeof cf?.asn === 'number' ? `AS${cf.asn} ${String(cf.asOrganization ?? '')}`.trim().slice(0, 100) : null,
  };
}

export async function ingest(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  ua: string,
  geo: Geo,
  now: number,
  signals: string | null = null,
) {
  const path = normalizePath(url.pathname);
  const { t, vid, sid } = body;

  if (t === 'ping') {
    const ms = Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0)));
    await db
      .prepare('UPDATE sessions SET duration = duration + ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
      .bind(ms, now, site.id, sid)
      .run();
    return;
  }

  // The visitor scrolled, tapped, clicked or typed: something a page-loading bot rarely does.
  if (t === 'engage') {
    const e = engageOf(body);
    await db
      .prepare('UPDATE sessions SET engaged = 1, engage_kind = COALESCE(engage_kind, ?), engage_ms = COALESCE(engage_ms, ?) WHERE site_id = ? AND id = ?')
      .bind(e.kind, e.ms, site.id, sid)
      .run();
    return;
  }

  if (t === 'identify') {
    const p = body.p ?? {};
    const email = clip(p.email, 200)?.toLowerCase() ?? null;
    const loginName = clip(p.name, 128) || email || clip(p.user_id, 128) || null;
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, vid, now),
      db
        .prepare(
          'UPDATE visitors SET user_id = COALESCE(?, user_id), email = COALESCE(?, email), name = COALESCE(?, name) WHERE site_id = ? AND id = ?',
        )
        .bind(clip(p.user_id, 128), email, clip(p.name, 128), site.id, vid),
      // The site says who is logged in on every page; keep the first one per visit (and per account) so the
      // visitor's timeline shows they were logged in, and from when.
      db
        .prepare(
          `INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props)
           SELECT ?, ?, ?, ?, 'identify', ?, ?, NULL
           WHERE NOT EXISTS (SELECT 1 FROM events WHERE site_id = ? AND session_id = ? AND type = 'identify' AND name IS ?)`,
        )
        .bind(site.id, sid, vid, now, loginName, path, site.id, sid, loginName),
      // A subscriber who logs in now is linked to their earlier payments that had no visit (e.g. automatic
      // renewals), credited to how they first arrived. Payments matched some other way are left alone.
      ...(email
        ? [
            db
              .prepare(
                `UPDATE payments SET visitor_id = ?, matched_by = 'email', session_id = (${firstTouchSessionSql()})
                 WHERE site_id = ? AND email = ? AND (visitor_id IS NULL OR (visitor_id = ? AND session_id IS NULL))`,
              )
              .bind(vid, site.id, vid, site.id, email, vid),
          ]
        : []),
    ]);
    return;
  }

  const existing = await db
    .prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?')
    .bind(site.id, sid)
    .first();

  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(...newSession(db, site, body, url, path, ua, geo, now, signals));
  }

  if (t === 'pageview') {
    if (existing) {
      stmts.push(
        db
          .prepare('UPDATE sessions SET pageviews = pageviews + 1, exit_page = ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
          .bind(path, now, site.id, sid),
      );
    }
    stmts.push(insertEvent(db, site.id, sid, vid, now, 'pageview', null, path, null));
    stmts.push(...claimPayment(db, site.id, vid, url, now));
  } else if (t === 'goal') {
    const name = clip(body.n, 64);
    if (!name) return;
    const props = body.p && typeof body.p === 'object' ? JSON.stringify(body.p).slice(0, 1000) : null;
    stmts.push(
      db.prepare('UPDATE sessions SET goals = goals + 1, last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'goal', name, path, props),
    );
  } else if (t === 'outbound') {
    const target = clip(body.n, 500);
    if (!target) return;
    stmts.push(
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'outbound', target, path, null),
    );
  }
  await db.batch(stmts);

  // A link to a Dodo checkout, or a buyer back on the return page, tells which site a product belongs to.
  const product = t === 'outbound' ? dodoProductOfLink(String(body.n ?? '')) : null;
  const paid = t === 'pageview' ? url.searchParams.get('payment_id') : null;
  if (product || (paid && /^pay_[\w-]{4,64}$/.test(paid))) await learnDodoProducts(db, site, product ? [product] : [], paid);
}

const DODO_CLAIM_ID = /^(pay|sub)_[\w-]{4,64}$/;
const STRIPE_CLAIM_ID = /^cs_(test|live)_\w{4,200}$/;
const UUID_CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dodo sends buyers back to your return URL with ?payment_id=pay_... (or ?subscription_id=sub_...),
 * Stripe with ?session_id=cs_... (when the success URL has {CHECKOUT_SESSION_ID}) and Polar with
 * ?checkout_id=<uuid>. Seeing that on a pageview tells us exactly which visitor made the payment,
 * even when the checkout had no metadata.
 */
function claimPayment(db: D1Database, siteId: string, vid: string, url: URL, now: number): D1PreparedStatement[] {
  const q = url.searchParams;
  const paymentId = q.get('payment_id') ?? q.get('subscription_id') ?? q.get('session_id') ?? q.get('checkout_id');
  if (!paymentId || !(DODO_CLAIM_ID.test(paymentId) || STRIPE_CLAIM_ID.test(paymentId) || UUID_CLAIM_ID.test(paymentId))) return [];
  return [
    db
      .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
      .bind(siteId, paymentId, vid, now),
    // The webhook usually arrives first; link that payment now if nothing else already did.
    db
      .prepare(
        `UPDATE payments SET visitor_id = ?, matched_by = 'return_page',
           session_id = (${creditedSessionSql()})
         WHERE site_id = ? AND ? IN (id, subscription_id, checkout_id) AND visitor_id IS NULL`,
      )
      .bind(vid, siteId, vid, now + 60_000, siteId, paymentId),
    db
      .prepare(
        `UPDATE visitors SET email = COALESCE(email, (SELECT email FROM payments WHERE site_id = ? AND ? IN (id, subscription_id, checkout_id) LIMIT 1)),
           name = COALESCE(name, (SELECT name FROM payments WHERE site_id = ? AND ? IN (id, subscription_id, checkout_id) LIMIT 1))
         WHERE site_id = ? AND id = ?`,
      )
      .bind(siteId, paymentId, siteId, paymentId, siteId, vid),
  ];
}

function insertEvent(
  db: D1Database,
  siteId: string,
  sid: string,
  vid: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  props: string | null,
) {
  return db
    .prepare('INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, sid, vid, ts, type, name, path, props);
}

function newSession(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  path: string,
  ua: string,
  geo: Geo,
  now: number,
  signals: string | null,
): D1PreparedStatement[] {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (body.r) {
    try {
      const r = new URL(body.r);
      // Navigation between your own pages/subdomains is not a referral.
      if (/^https?:$/.test(r.protocol) && !belongsTo(r.hostname, site.domain)) {
        referrerDomain = stripWww(r.hostname);
        referrer = (r.hostname + normalizePath(r.pathname)).slice(0, 500);
      }
    } catch {
      // android-app://com.google.android.gm and friends
      const m = /^android-app:\/\/([\w.]+)/.exec(body.r);
      if (m) referrerDomain = m[1];
    }
  }
  const q = url.searchParams;
  const utm = {
    source: clip(q.get('utm_source'), 100),
    medium: clip(q.get('utm_medium'), 100),
    campaign: clip(q.get('utm_campaign'), 200),
    term: clip(q.get('utm_term'), 200),
    content: clip(q.get('utm_content'), 200),
  };
  const ref = clip(q.get('ref') ?? q.get('via'), 100);
  const { source, channel } = classify({ referrerDomain, utmSource: utm.source, utmMedium: utm.medium, ref });
  const { browser, os, device } = parseUA(ua, Number(body.sw) || undefined);
  const pageviews = body.t === 'pageview' ? 1 : 0;

  return [
    db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, body.vid, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, browser, os, device, lat, lon, signals, network)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        site.id,
        body.sid,
        body.vid,
        now,
        now,
        stripWww(url.hostname),
        path,
        path,
        referrer,
        referrerDomain,
        source,
        channel,
        utm.source,
        utm.medium,
        utm.campaign,
        utm.term,
        utm.content,
        ref,
        geo.country,
        geo.region,
        geo.city,
        browser,
        os,
        device,
        geo.lat,
        geo.lon,
        signals,
        geo.network,
      ),
    // Separate statement so concurrent first events (pageview + goal racing) never double count.
    ...(pageviews
      ? [db.prepare('UPDATE sessions SET pageviews = pageviews + 1 WHERE site_id = ? AND id = ?').bind(site.id, body.sid)]
      : []),
  ];
}
