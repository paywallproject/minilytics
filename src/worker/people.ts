import type { Context } from 'hono';
import { ADMIN_ID, adminEmail, isHosted } from './auth';
import { forgetSite, type AppEnv, type Env } from './env';
import { hashPassword, randomId } from './lib/crypto';

const ROLES = ['viewer', 'manager'] as const;
type MemberRole = (typeof ROLES)[number];

export const cleanEmail = (input: unknown) => (typeof input === 'string' ? input.trim().toLowerCase() : '');
export const validEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * The email + password account for this email, created with a random temporary password if there's none.
 * `password` is only set for a new account; it's shown once, to whoever added them, to pass on.
 */
export async function findOrCreateAccount(db: D1Database, email: string): Promise<{ id: string; email: string; password: string | null }> {
  const found = await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(email, ADMIN_ID).first<{ id: string }>();
  if (found) return { id: found.id, email, password: null };
  const id = randomId(10);
  const password = randomId(12);
  try {
    await db.prepare('INSERT INTO users (id, email, created_at, password_hash) VALUES (?, ?, ?, ?)').bind(id, email, Date.now(), await hashPassword(password)).run();
  } catch {
    // Created at the same moment by another request: use that one.
    const again = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
    if (again) return { id: again.id, email, password: null };
    throw new Error('Could not create the account');
  }
  return { id, email, password };
}

/** Self-hosted only: the admin's own email can't become another account (it logs in as the admin). */
export function emailProblemFor(env: Env, email: string): string | null {
  if (!validEmail(email)) return 'Enter a valid email.';
  if (!isHosted(env) && email === adminEmail(env)) return "That's the admin's email. The admin already sees every site.";
  return null;
}
const emailProblem = (c: Context<AppEnv>, email: string) => emailProblemFor(c.env, email);

const canManagePeople = (c: Context<AppEnv>) => ['admin', 'owner', 'manager'].includes(c.get('role') ?? '');

// ---------- people on a site

/** The owner and everyone added to this site. */
export async function listPeople(c: Context<AppEnv>) {
  if (!canManagePeople(c)) return c.json({ error: 'Only the owner and managers can see who has access.' }, 403);
  const site = c.get('site');
  const [owner, members] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(site.owner_id ?? ''),
    c.env.DB.prepare(
      `SELECT m.user_id AS id, u.email, m.role, m.created_at FROM site_members m JOIN users u ON u.id = m.user_id
       WHERE m.site_id = ? ORDER BY m.created_at`,
    ).bind(site.id),
  ]);
  return c.json({ owner: owner.results[0] ?? null, members: members.results });
}

/** Give someone access by email. Creates their login if they don't have one. Adding them again changes the role. */
export async function addPerson(c: Context<AppEnv>) {
  if (!canManagePeople(c)) return c.json({ error: 'Only the owner and managers can add people.' }, 403);
  const site = c.get('site');
  const b = await c.req.json<{ email?: string; role?: string }>().catch(() => ({}) as { email?: string; role?: string });
  const email = cleanEmail(b.email);
  const role = (ROLES as readonly string[]).includes(b.role ?? '') ? (b.role as MemberRole) : 'viewer';
  const problem = emailProblem(c, email);
  if (problem) return c.json({ error: problem }, 400);
  const account = await findOrCreateAccount(c.env.DB, email);
  if (account.id === site.owner_id) return c.json({ error: 'That person owns this site already.' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO site_members (site_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (site_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(site.id, account.id, role, Date.now())
    .run();
  return c.json({ id: account.id, email, role, password: account.password });
}

export async function changePerson(c: Context<AppEnv>) {
  if (!canManagePeople(c)) return c.json({ error: 'Only the owner and managers can change access.' }, 403);
  const b = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
  if (!(ROLES as readonly string[]).includes(b.role ?? '')) return c.json({ error: 'role must be viewer or manager' }, 400);
  const r = await c.env.DB.prepare('UPDATE site_members SET role = ? WHERE site_id = ? AND user_id = ?').bind(b.role, c.get('site').id, c.req.param('uid')).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Not on this site' }, 404);
}

/** Take away someone's access. Their login stays (they may be on other sites); it just stops showing this one. */
export async function removePerson(c: Context<AppEnv>) {
  if (!canManagePeople(c)) return c.json({ error: 'Only the owner and managers can remove people.' }, 403);
  await c.env.DB.prepare('DELETE FROM site_members WHERE site_id = ? AND user_id = ?').bind(c.get('site').id, c.req.param('uid')).run();
  return c.json({ ok: true });
}

// ---------- admin: hand a site to a client

/**
 * Make a client the owner of this site (self-hosted admin and staff only). Everything stays: the site id, the
 * tracking script, the API key, all data and imports. The admin keeps seeing it; anyone added to it keeps access.
 */
export async function transferSite(c: Context<AppEnv>) {
  if (c.get('role') !== 'admin') return c.json({ error: 'Only the admin can move a site to a client.' }, 403);
  const site = c.get('site');
  const b = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = cleanEmail(b.email);
  const problem = emailProblem(c, email);
  if (problem) return c.json({ error: problem }, 400);
  const account = await findOrCreateAccount(c.env.DB, email);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE sites SET owner_id = ? WHERE id = ?').bind(account.id, site.id),
    // The new owner doesn't also need a member row.
    c.env.DB.prepare('DELETE FROM site_members WHERE site_id = ? AND user_id = ?').bind(site.id, account.id),
  ]);
  forgetSite(site.id);
  return c.json({ owner: { id: account.id, email, password: account.password } });
}

/** Give a client's site back to the admin (no owner). */
export async function untransferSite(c: Context<AppEnv>) {
  if (c.get('role') !== 'admin') return c.json({ error: 'Only the admin can do this.' }, 403);
  await c.env.DB.prepare('UPDATE sites SET owner_id = NULL WHERE id = ?').bind(c.get('site').id).run();
  forgetSite(c.get('site').id);
  return c.json({ ok: true });
}

// ---------- admin: staff (the admin's teammates; self-hosted)

const isMainAdmin = (c: Context<AppEnv>) => !isHosted(c.env) && c.get('user').id === ADMIN_ID;

export async function listStaff(c: Context<AppEnv>) {
  if (!isMainAdmin(c)) return c.json({ error: 'Only the main admin can manage staff.' }, 403);
  const r = await c.env.DB.prepare('SELECT id, email, created_at FROM users WHERE staff = 1 AND id != ? ORDER BY created_at').bind(ADMIN_ID).all();
  return c.json(r.results);
}

export async function addStaff(c: Context<AppEnv>) {
  if (!isMainAdmin(c)) return c.json({ error: 'Only the main admin can manage staff.' }, 403);
  const b = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = cleanEmail(b.email);
  const problem = emailProblem(c, email);
  if (problem) return c.json({ error: problem }, 400);
  const account = await findOrCreateAccount(c.env.DB, email);
  await c.env.DB.prepare('UPDATE users SET staff = 1 WHERE id = ?').bind(account.id).run();
  return c.json({ id: account.id, email, password: account.password });
}

export async function removeStaff(c: Context<AppEnv>) {
  if (!isMainAdmin(c)) return c.json({ error: 'Only the main admin can manage staff.' }, 403);
  await c.env.DB.prepare('UPDATE users SET staff = 0 WHERE id = ? AND id != ?').bind(c.req.param('uid'), ADMIN_ID).run();
  return c.json({ ok: true });
}
