import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { handleEvent } from './collect';
import { HOLD_MS } from './lib/hold';
import { forgetSite, type AppEnv, type Site } from './env';
import { ADMIN_ID, adminEmail, clearSession, currentUser, emailLogin, googleCallback, googleStart, isHosted, requireUser, setSession, signupOpen, siteAccessSql, siteRole, type SiteRole, type User } from './auth';
import { billingWebhook, checkout, planInfo } from './billing';
import { hashPassword, passwordsMatch, randomId, verifyPassword } from './lib/crypto';
import { handleDodoWebhook, handleGoalApi, handlePaymentApi, handlePolarWebhook, handleStripeWebhook, learnDodoProducts, rematchPayments } from './payments';
import { addImportRows, clearImports, deleteImport, finishImport, getImport, startImport } from './imports';
import { rememberOwnerDevice } from './owner';
import { addPerson, addStaff, changePerson, cleanEmail, emailProblemFor, findOrCreateAccount, listPeople, listStaff, removePerson, removeStaff, setPersonReport, transferSite, untransferSite } from './people';
import { defaultSubscription, emailConfigured, gatherReport, isFrequency, linksFor, renderEmail, reportPeriod, runScheduledReports, sendEmail, setSubscription, writeSummary } from './reports';
import { verifyToken } from './lib/crypto';
import { breakdown, customers, funnel, makeCtx, overview, realtime, sparklines, visitorProfile, visitors, type FunnelStep } from './stats';

const app = new Hono<AppEnv>();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

// Basic hardening for everything the Worker answers (API and app pages). Static files get the same
// headers from public/_headers. The tracking script and endpoint stay embeddable on customers' sites.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (c.req.path.startsWith('/api/')) {
    // Stats, settings and secrets must never sit in a shared or browser cache.
    if (c.req.path !== '/api/event' && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  } else {
    // The dashboard can't be framed by another site (clickjacking).
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  }
});

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.post('/api/event', handleEvent);
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/webhooks/stripe/:siteId', handleStripeWebhook);
app.post('/api/webhooks/polar/:siteId', handlePolarWebhook);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);

// ---------- login

/**
 * Lock an IP out after too many attempts (login, sign-up, password change), so a public dashboard can't be
 * brute-forced. The attempt is recorded and counted in one atomic batch BEFORE the password is checked: checking
 * first and recording afterwards would let a burst of parallel guesses all slip under the limit.
 */
async function tooManyAttempts(c: Context<AppEnv>) {
  const now = Date.now();
  const [, , attempts] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    c.env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(clientIp(c), now),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?').bind(clientIp(c), now - LOCKOUT_MS),
  ]);
  return ((attempts.results[0] as { n: number } | undefined)?.n ?? 0) > MAX_FAILURES;
}
const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';
const forgetAttempts = (c: Context<AppEnv>) => c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(clientIp(c)).run();
const slowDown = () => new Promise((r) => setTimeout(r, 500));
const TOO_MANY = 'Too many attempts. Try again in 15 minutes.';
const MIN_PASSWORD = 8;

/** Is this the admin's password? A password set in the dashboard replaces ADMIN_PASSWORD. */
async function adminPasswordOk(c: Context<AppEnv>, password: string) {
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(ADMIN_ID).first<{ password_hash: string | null }>();
  return row?.password_hash ? verifyPassword(password, row.password_hash) : passwordsMatch(password, c.env.ADMIN_PASSWORD);
}

async function accountPasswordOk(c: Context<AppEnv>, userId: string, password: string) {
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string | null }>();
  return verifyPassword(password, row?.password_hash);
}

app.post('/api/auth/login', async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }
  if (await tooManyAttempts(c)) return c.json({ error: TOO_MANY }, 429);
  const b = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
  const email = (b.email ?? '').trim().toLowerCase();
  const password = b.password ?? '';
  const admin = adminEmail(c.env);
  let subject: string | null = null;
  if (password && (admin ? email === admin : !email)) {
    if (await adminPasswordOk(c, password)) subject = ADMIN_ID;
  } else if (password && email) {
    const row = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND password_hash IS NOT NULL')
      .bind(email, ADMIN_ID)
      .first<{ id: string }>();
    if (row && (await accountPasswordOk(c, row.id, password))) subject = `u:${row.id}`;
  }
  if (!subject) {
    await slowDown();
    return c.json({ error: emailLogin(c.env) ? 'Wrong email or password' : 'Wrong password' }, 401);
  }
  await forgetAttempts(c);
  await setSession(c, subject);
  return c.json({ ok: true });
});

app.post('/api/auth/signup', async (c) => {
  if (!signupOpen(c.env)) return c.json({ error: 'Sign-up is closed.' }, 403);
  if (!c.env.SESSION_SECRET) return c.json({ error: 'Set SESSION_SECRET (see README).' }, 500);
  // Counts toward the same limit as logins, so one IP can't create accounts in bulk.
  if (await tooManyAttempts(c)) return c.json({ error: TOO_MANY }, 429);
  const b = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
  const email = (b.email ?? '').trim().toLowerCase();
  const password = b.password ?? '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);
  if (password.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the password.` }, 400);
  if (password.length > 200) return c.json({ error: 'That password is too long.' }, 400);
  const taken = email === adminEmail(c.env) || !!(await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first());
  if (taken) return c.json({ error: 'An account with this email already exists. Log in instead.' }, 409);
  const id = randomId(10);
  try {
    await c.env.DB.prepare('INSERT INTO users (id, email, created_at, password_hash) VALUES (?, ?, ?, ?)')
      .bind(id, email, Date.now(), await hashPassword(password))
      .run();
  } catch {
    // Two sign-ups with the same email at once: the unique index stops the second.
    return c.json({ error: 'An account with this email already exists. Log in instead.' }, 409);
  }
  await setSession(c, `u:${id}`);
  return c.json({ ok: true });
});

app.post('/api/auth/password', requireUser, async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'You sign in with Google, so there is no password to change.' }, 400);
  if (await tooManyAttempts(c)) return c.json({ error: TOO_MANY }, 429);
  const user = c.get('user');
  const b = await c.req.json<{ current?: string; next?: string }>().catch(() => ({}) as { current?: string; next?: string });
  const current = b.current ?? '';
  const next = b.next ?? '';
  if (next.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the new password.` }, 400);
  if (next.length > 200) return c.json({ error: 'That password is too long.' }, 400);
  const ok = !!current && (user.id === ADMIN_ID ? await adminPasswordOk(c, current) : await accountPasswordOk(c, user.id, current));
  if (!ok) {
    await slowDown();
    return c.json({ error: 'Your current password is wrong.' }, 400);
  }
  const hash = await hashPassword(next);
  const now = Date.now();
  if (user.id === ADMIN_ID) {
    // The admin gets a users row the first time; from then on it holds their password instead of ADMIN_PASSWORD.
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, created_at, password_hash, password_changed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at`,
    )
      .bind(ADMIN_ID, adminEmail(c.env) ?? 'admin', now, hash, now)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').bind(hash, now, user.id).run();
  }
  await forgetAttempts(c);
  // Other browsers are now signed out; keep this one signed in.
  await setSession(c, user.id === ADMIN_ID ? ADMIN_ID : `u:${user.id}`);
  return c.json({ ok: true });
});

app.get('/api/auth/google', googleStart);
app.get('/api/auth/google/callback', googleCallback);

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

/**
 * May this account add websites? Self-hosted: the admin and staff, and anyone who owns or manages a site.
 * People who only have view access to someone else's site can't (unless sign-up is open, where anyone may).
 */
async function canAddSites(c: Context<AppEnv>, user: User) {
  if (isHosted(c.env) || user.admin || signupOpen(c.env)) return true;
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM sites WHERE owner_id = ? UNION ALL SELECT 1 FROM site_members WHERE user_id = ? AND role = 'manager' LIMIT 1`,
  )
    .bind(user.id, user.id)
    .first();
  return !!row;
}

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c);
  if (user) c.executionCtx.waitUntil(rememberOwnerDevice(c, user).catch(() => {}));
  const canAdd = user ? await canAddSites(c, user) : false;
  return c.json({ loggedIn: !!user, hosted: isHosted(c.env), emailLogin: emailLogin(c.env), signup: signupOpen(c.env), canAddSites: canAdd, user });
});

// ---------- billing (hosted mode)

app.get('/api/public/plan', async (c) => c.json(await planInfo(c.env)));
app.post('/api/billing/webhook', billingWebhook);
app.get('/api/billing/checkout', requireUser, checkout);

// ---------- your email reports (any login; for every site you can see)

app.get('/api/reports', requireUser, async (c) => {
  const user = c.get('user');
  const access = siteAccessSql(c.env, user);
  const r = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.domain, r.frequency FROM sites s
     LEFT JOIN report_subscriptions r ON r.site_id = s.id AND r.user_id = ?
     WHERE ${access.sql} ORDER BY s.created_at`,
  )
    .bind(user.id, ...access.params)
    .all();
  return c.json({ sites: r.results, email: user.email, sending: emailConfigured(c.env) });
});

app.put('/api/reports/:siteId', requireUser, async (c) => {
  const user = c.get('user');
  const b = await c.req.json<{ frequency?: string }>().catch(() => ({}) as { frequency?: string });
  if (b.frequency !== 'off' && !isFrequency(b.frequency)) return c.json({ error: 'frequency must be off, weekly or monthly' }, 400);
  const access = siteAccessSql(c.env, user);
  const site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`).bind(c.req.param('siteId'), ...access.params).first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  if (!user.email && b.frequency !== 'off') return c.json({ error: 'Your login has no email address.' }, 400);
  await setSubscription(c.env.DB, site, user.id, b.frequency);
  return c.json({ ok: true });
});

/** The unsubscribe link in each report (and the one-click List-Unsubscribe POST from mail apps). No login needed. */
async function unsubscribe(c: Context<AppEnv>, confirmed: boolean) {
  const value = await verifyToken(c.env.SESSION_SECRET, c.req.query('t'));
  const [, siteId, userId] = value?.split(':') ?? [];
  const page = (body: string) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email reports</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;padding:48px 16px">
<div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:28px">${body}</div></body>`,
    );
  if (!value?.startsWith('unsub:') || !siteId || !userId) return page('<h1 style="font-size:20px">This link isn’t valid</h1><p>Change your email reports from your account page instead.</p>');
  const site = await c.env.DB.prepare('SELECT name, domain FROM sites WHERE id = ?').bind(siteId).first<{ name: string; domain: string }>();
  const name = (site?.name ?? 'this site').replace(/[&<>"']/g, '');
  if (!confirmed) {
    // A button rather than unsubscribing on GET, so link scanners in mail systems don't unsubscribe people.
    return page(
      `<h1 style="font-size:20px;margin:0 0 8px">Stop email reports for ${name}?</h1>
<form method="post"><button style="margin-top:12px;background:#1c1917;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer">Unsubscribe</button></form>`,
    );
  }
  await c.env.DB.prepare('DELETE FROM report_subscriptions WHERE site_id = ? AND user_id = ?').bind(siteId, userId).run();
  return page(`<h1 style="font-size:20px;margin:0 0 8px">You’re unsubscribed</h1><p style="color:#57534e">You won’t get email reports for ${name} any more. You can turn them back on from your account page.</p>`);
}
app.get('/api/reports/unsubscribe', (c) => unsubscribe(c, false));
app.post('/api/reports/unsubscribe', (c) => unsubscribe(c, true));

// ---------- dashboard API (login required, except viewing a public site)

app.use('/api/sites', requireUser);

// What a visitor without access may load from a public site: the dashboard's data, never its settings.
const PUBLIC_READS = /^\/api\/sites\/[\w-]+(\/(overview|breakdown|realtime|customers|visitors(\/[\w-]+)?|funnels(\/[\w-]+\/stats)?))?\/?$/;

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const id = c.req.param('id');
  const user = await currentUser(c);
  const publicRead = c.req.method === 'GET' && PUBLIC_READS.test(c.req.path);
  if (user) {
    c.set('user', user);
    // The self-hosted admin and staff can open every site; others their own and the ones they were added to.
    const access = siteAccessSql(c.env, user);
    const site = await c.env.DB.prepare(
      `SELECT s.*, (SELECT role FROM site_members WHERE site_id = s.id AND user_id = ?) AS member_role FROM sites s WHERE s.id = ? AND ${access.sql}`,
    )
      .bind(user.id, id, ...access.params)
      .first<Site & { member_role: string | null }>();
    const role = site && siteRole(c.env, user, site);
    if (site && role) {
      const { member_role: _, ...plain } = site;
      // Viewers get what a public dashboard shows: the stats, never the settings or keys.
      if (role === 'viewer' && !publicRead) return c.json({ error: 'You have view-only access to this site.' }, 403);
      c.set('site', plain);
      c.set('role', role);
      c.set('readOnly', role === 'viewer');
      return next();
    }
  }
  if (publicRead) {
    const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ? AND public = 1').bind(id).first<Site>();
    if (site) {
      c.set('site', site);
      c.set('role', null);
      c.set('readOnly', true);
      return next();
    }
  }
  return user ? c.json({ error: 'site not found' }, 404) : c.json({ error: 'unauthorized' }, 401);
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mask = (secret: string | null | undefined) => (secret ? '••••••••' : null);
const ownerSite = (s: Site, role: SiteRole | null = 'owner') => ({
  ...s,
  role,
  dodo_webhook_secret: mask(s.dodo_webhook_secret),
  stripe_webhook_secret: mask(s.stripe_webhook_secret),
  polar_webhook_secret: mask(s.polar_webhook_secret),
  readOnly: false,
});
// Someone viewing a public site: what the dashboard needs, and none of the keys or secrets.
const viewerSite = (s: Site) => ({
  id: s.id,
  name: s.name,
  domain: s.domain,
  timezone: s.timezone,
  currency: s.currency,
  created_at: s.created_at,
  public: s.public,
  role: null as SiteRole | null,
  readOnly: true,
});

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const user = c.get('user');
  const access = siteAccessSql(c.env, user);
  const [sites, stats] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT s.*, u.email AS owner_email, (SELECT role FROM site_members WHERE site_id = s.id AND user_id = ?) AS member_role
       FROM sites s LEFT JOIN users u ON u.id = s.owner_id WHERE ${access.sql} ORDER BY s.created_at`,
    ).bind(user.id, ...access.params),
    c.env.DB.prepare(
      `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online
       FROM sessions WHERE started_at > ? GROUP BY site_id`,
    ).bind(now - 5 * 60_000, now - 86_400_000),
  ]);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  return c.json(
    (sites.results as unknown as (Site & { owner_email: string | null; member_role: string | null })[]).map(({ owner_email, member_role, ...s }) => {
      const role = siteRole(c.env, user, { owner_id: s.owner_id, member_role });
      return {
        ...(role === 'viewer' ? viewerSite(s) : ownerSite(s, role)),
        role,
        // Admins see whose site it is (null = their own); others only see that it's shared with them.
        owner: role === 'admin' ? owner_email : role === 'owner' ? null : owner_email ?? adminEmail(c.env),
        visitors24h: by.get(s.id)?.visitors ?? 0,
        online: by.get(s.id)?.online ?? 0,
      };
    }),
  );
});

// Every site's totals and sparkline for the all-websites view.
app.use('/api/sites-overview', requireUser);
app.get('/api/sites-overview', async (c) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const rows = await c.env.DB.prepare(`SELECT s.id FROM sites s WHERE ${access.sql}`).bind(...access.params).all<{ id: string }>();
  return c.json(await sparklines(c.env.DB, rows.results.map((r) => r.id), c.req.query('period') ?? '30d'));
});

app.post('/api/sites', async (c) => {
  const user = c.get('user');
  if (isHosted(c.env) && !user.paid) return c.json({ error: 'Choose a plan to add websites.' }, 402);
  if (!(await canAddSites(c, user))) return c.json({ error: 'Your login can view sites shared with you, but not add websites.' }, 403);
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  // Self-hosted admin sites have no owner (the admin owns those); every account owns its own.
  const admin = user.admin && !isHosted(c.env);
  const site = await createSite(c.env.DB, b, admin ? null : user.id);
  return typeof site === 'string' ? c.json({ error: site }, 400) : c.json(ownerSite(site, admin ? 'admin' : 'owner'));
});

/** Add a site for `ownerId` (null = the self-hosted admin). Returns an error message for bad input. */
async function createSite(db: D1Database, b: Partial<Site>, ownerId: string | null): Promise<Site | string> {
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return 'Enter a domain like example.com';
  if (b.timezone && !validTimezone(b.timezone)) return 'Unknown timezone';
  const tz = b.timezone || 'UTC';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'ml_' + randomId(16),
    dodo_webhook_secret: null,
    polar_webhook_secret: null,
    created_at: Date.now(),
  };
  await db
    .prepare(
      'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, polar_webhook_secret, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, null, site.created_at, ownerId)
    .run();
  return { ...site, owner_id: ownerId };
}

// ---------- admin: set up a client (self-hosted admin only)

/**
 * Create a client's email + password account and a site it owns, in one call. Safe to repeat: an existing
 * account or site for that email + domain is reused, and the password is only returned when the account is new.
 * The client logs in at the dashboard and sees only their own sites; the admin can open the site by its link.
 */
app.use('/api/admin/*', requireUser);
app.post('/api/admin/clients', async (c) => {
  const user = c.get('user');
  if (!user.admin || isHosted(c.env)) return c.json({ error: 'Only the self-hosted admin can add clients.' }, 403);
  const b = await c.req.json<Partial<Site> & { email?: string }>().catch(() => ({}) as Partial<Site> & { email?: string });
  const email = cleanEmail(b.email);
  const problem = emailProblemFor(c.env, email);
  if (problem) return c.json({ error: problem }, 400);
  if (!b.timezone || !validTimezone(b.timezone)) return c.json({ error: 'Give the timezone the client uses in Plausible.' }, 400);

  const account = await findOrCreateAccount(c.env.DB, email);
  const domain = cleanDomain(b.domain ?? '');
  const existing = await c.env.DB.prepare('SELECT * FROM sites WHERE owner_id = ? AND domain = ?').bind(account.id, domain).first<Site>();
  // A site the admin already added for this domain (no owner) is handed over rather than duplicated, keeping its data.
  const adminSite = existing ? null : await c.env.DB.prepare('SELECT * FROM sites WHERE owner_id IS NULL AND domain = ? ORDER BY created_at LIMIT 1').bind(domain).first<Site>();
  if (adminSite) {
    await c.env.DB.prepare('UPDATE sites SET owner_id = ? WHERE id = ?').bind(account.id, adminSite.id).run();
    forgetSite(adminSite.id);
  }
  const site = existing ?? (adminSite ? { ...adminSite, owner_id: account.id } : await createSite(c.env.DB, b, account.id));
  if (typeof site === 'string') return c.json({ error: site }, 400);
  await defaultSubscription(c.env.DB, site, account.id); // new clients get the weekly email report
  return c.json({
    account: { id: account.id, email, password: account.password, created: !!account.password },
    site: { ...ownerSite(site, 'admin'), created: !existing && !adminSite, moved: !!adminSite },
  });
});

// Staff: the admin's teammates, who see and manage every site.
app.get('/api/admin/staff', listStaff);
app.post('/api/admin/staff', addStaff);
app.delete('/api/admin/staff/:uid', removeStaff);

app.get('/api/sites/:id', (c) => c.json(c.get('readOnly') ? { ...viewerSite(c.get('site')), role: c.get('role') } : ownerSite(c.get('site'), c.get('role'))));

// Who can log in to see this site.
app.get('/api/sites/:id/people', listPeople);
app.post('/api/sites/:id/people', addPerson);
app.patch('/api/sites/:id/people/:uid', changePerson);
app.delete('/api/sites/:id/people/:uid', removePerson);
// Admin: make a client the owner, or take it back.
app.post('/api/sites/:id/transfer', transferSite);
app.delete('/api/sites/:id/transfer', untransferSite);
app.put('/api/sites/:id/people/:uid/report', setPersonReport);

// ---------- email reports

const baseUrl = (c: Context<AppEnv>) => (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
const canSeeReport = (c: Context<AppEnv>) => ['admin', 'owner', 'manager'].includes(c.get('role') ?? '');

/** This site's report as it would be emailed now (the last full week or month), to look at in the browser. */
app.get('/api/sites/:id/report/preview', async (c) => {
  if (!canSeeReport(c)) return c.json({ error: 'Only the owner and managers can preview reports.' }, 403);
  const site = c.get('site');
  const frequency = isFrequency(c.req.query('frequency')) ? (c.req.query('frequency') as 'weekly' | 'monthly') : 'weekly';
  const period = reportPeriod(frequency, site.timezone);
  const data = await gatherReport(c.env.DB, site, period);
  const summary = await writeSummary(c.env, data);
  const mail = renderEmail(data, summary, await linksFor(c.env, baseUrl(c), period, site.id, null));
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
  return c.html(mail.html);
});

/** Email this site's report to yourself now. */
app.post('/api/sites/:id/report/test', async (c) => {
  if (!canSeeReport(c)) return c.json({ error: 'Only the owner and managers can send a test report.' }, 403);
  if (!emailConfigured(c.env)) return c.json({ error: 'Email sending isn’t set up yet (Amazon SES settings are missing).' }, 400);
  const user = c.get('user');
  const to = user.email;
  if (!to) return c.json({ error: 'Your login has no email address.' }, 400);
  const site = c.get('site');
  const b = await c.req.json<{ frequency?: string }>().catch(() => ({}) as { frequency?: string });
  const frequency = isFrequency(b.frequency) ? b.frequency : 'weekly';
  const period = reportPeriod(frequency, site.timezone);
  const data = await gatherReport(c.env.DB, site, period);
  const summary = await writeSummary(c.env, data);
  const links = await linksFor(c.env, baseUrl(c), period, site.id, null);
  try {
    await sendEmail(c.env, to, renderEmail(data, summary, links), null);
  } catch (e) {
    console.error('test report failed', e);
    return c.json({ error: `Sending failed: ${(e as Error).message}` }, 502);
  }
  return c.json({ ok: true, to, summary: !!summary });
});

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim() || null;
  }
  if (typeof b.stripe_webhook_secret === 'string' && !b.stripe_webhook_secret.includes('•')) {
    next.stripe_webhook_secret = b.stripe_webhook_secret.trim() || null;
  }
  if (typeof b.polar_webhook_secret === 'string' && !b.polar_webhook_secret.includes('•')) {
    next.polar_webhook_secret = b.polar_webhook_secret.trim() || null;
  }
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]+$/.test(x));
    next.dodo_product_ids = ids.join(',') || null;
  }
  if (b.public !== undefined) next.public = b.public ? 1 : 0;
  await c.env.DB.prepare(
    'UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, dodo_product_ids = ?, stripe_webhook_secret = ?, polar_webhook_secret = ?, public = ? WHERE id = ?',
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.dodo_product_ids ?? null,
      next.stripe_webhook_secret ?? null,
      next.polar_webhook_secret ?? null,
      next.public ? 1 : 0,
      site.id,
    )
    .run();
  forgetSite(site.id);
  return c.json(ownerSite(next, c.get('role')));
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'ml_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  if (c.get('role') === 'manager') return c.json({ error: 'Only the owner can delete this site.' }, 403);
  const id = c.get('site').id;
  await clearImports(c.env.DB, id).catch(() => {}); // no imports table before migration 0011
  await c.env.DB.batch(
    // Everything stored for the site, so deleting it really removes its visitors' data.
    ['events', 'sessions', 'visitors', 'payments', 'funnels', 'payment_claims', 'pending_payments', 'dodo_products', 'site_members', 'report_subscriptions'].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  forgetSite(id);
  return c.json({ ok: true });
});

// ---------- stats

app.get('/api/sites/:id/overview', async (c) => c.json(await overview(await makeCtx(c))));

// Bot-check dimensions under evaluation: only admins and staff see them.
const ADMIN_DIMS = new Set(['signals', 'engaged', 'network']);
app.get('/api/sites/:id/breakdown', async (c) => {
  if (ADMIN_DIMS.has(c.req.query('dim') ?? '') && c.get('role') !== 'admin') return c.json({ error: 'Not available' }, 403);
  try {
    return c.json(await breakdown(await makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Dodo payments that couldn't be placed on a site yet, grouped by product.
app.get('/api/sites/:id/pending-payments', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT product_id, COUNT(*) AS count, SUM(json_extract(payload, '$.amount')) AS amount, MAX(json_extract(payload, '$.currency')) AS currency
     FROM pending_payments WHERE site_id = ? GROUP BY product_id ORDER BY MAX(ts) DESC`,
  )
    .bind(c.get('site').id)
    .all();
  return c.json(r.results);
});
app.post('/api/sites/:id/pending-payments', async (c) => {
  const b = await c.req.json<{ product_id?: string }>().catch(() => ({}) as { product_id?: string });
  if (!b.product_id || !/^pdt_[\w-]+$/.test(b.product_id)) return c.json({ error: 'product_id is required' }, 400);
  await learnDodoProducts(c.env.DB, c.get('site'), [b.product_id]);
  return c.json({ ok: true });
});
app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(await makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(await makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

app.get('/api/sites/:id/funnels', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
});

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal') && typeof s.value === 'string' && s.value.trim())
    .slice(0, 10)
    .map((s) => ({ type: s.type, value: s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', async (c) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(await makeCtx(c), JSON.parse(f.steps)));
});

// History imported from Plausible (owner only: none of these are public reads).
app.get('/api/sites/:id/import', getImport);
app.post('/api/sites/:id/import', startImport);
app.post('/api/sites/:id/import/:iid/rows', addImportRows);
app.post('/api/sites/:id/import/:iid/finish', finishImport);
app.delete('/api/sites/:id/import', deleteImport);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Static files are served before the Worker runs. What reaches here is a client-side route, or a page that doesn't exist.
const PUBLIC_PAGES = /^\/(terms|privacy|refund)\/?$/;
const APP_PAGES = /^\/(billing(\/.*)?|account\/?|site\/[\w-]+(\/settings)?\/?)$/;

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const index = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const headers = new Headers(index.headers);
  // Signed-in pages are private and unknown paths shouldn't rank: keep both out of search results.
  if (!PUBLIC_PAGES.test(path)) headers.set('X-Robots-Tag', 'noindex');
  const status = PUBLIC_PAGES.test(path) || APP_PAGES.test(path) ? 200 : 404;
  const res = new Response(index.body, { status, headers });
  // A shared link to a public dashboard previews (Slack, iMessage, email) with the site's name and domain,
  // not the Minilytics homepage. Private sites keep the generic tags so their name never leaks.
  const dash = /^\/site\/([\w-]+)\/?$/.exec(path);
  if (!dash) return res;
  const site = await c.env.DB.prepare('SELECT name, domain FROM sites WHERE id = ? AND public = 1')
    .bind(dash[1])
    .first<{ name: string; domain: string }>();
  if (!site) return res;
  const title = `${site.name}${site.name.toLowerCase() !== site.domain.toLowerCase() ? ` (${site.domain})` : ''} · Minilytics`;
  const description = `Live visitor and revenue stats for ${site.domain}, shared with Minilytics.`;
  return new HTMLRewriter()
    .on('title', { element: (el) => void el.setInnerContent(title) })
    .on('meta[property="og:title"], meta[name="twitter:title"]', { element: (el) => void el.setAttribute('content', title) })
    .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', {
      element: (el) => void el.setAttribute('content', description),
    })
    .on('meta[property="og:url"], link[rel="canonical"]', { element: (el) => void el.remove() })
    .transform(res);
});

export default {
  fetch: app.fetch,
  // Hourly Cron Trigger (wrangler.jsonc): sends the email reports that are due and clears expired held visits.
  async scheduled(_controller: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledReports(env));
    // Held visits that never showed a sign of a person (see lib/hold.ts) are dropped.
    ctx.waitUntil(env.DB.prepare('DELETE FROM held_visits WHERE ts < ?').bind(Date.now() - HOLD_MS).run());
  },
} satisfies ExportedHandler<AppEnv['Bindings']>;
