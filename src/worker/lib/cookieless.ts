/**
 * Cookieless visits, for sites whose readers haven't allowed analytics cookies yet (the tracker's data-consent
 * mode). Nothing is stored on the reader's device: the visitor is identified for one UTC day by a hash of a random
 * daily salt, the site, the IP address and the browser's user agent. Salts are deleted after a day (index.ts
 * cron), so a visitor can't be recognised again once their day is over, not even by us. The same id is used as the
 * session, so a cookieless reader's visits on one day count as one visit.
 */

let cached: { day: string; salt: string } | null = null;

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

async function saltFor(db: D1Database, day: string): Promise<string> {
  if (cached?.day === day) return cached.salt;
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT OR IGNORE INTO cookieless_salts (day, salt) VALUES (?, ?)').bind(day, fresh).run();
  const row = await db.prepare('SELECT salt FROM cookieless_salts WHERE day = ?').bind(day).first<{ salt: string }>();
  const salt = row?.salt ?? fresh;
  cached = { day, salt };
  return salt;
}

/** Today's id for this reader on this site: 'ck' + 30 hex characters. */
export async function cookielessId(db: D1Database, siteId: string, ip: string, ua: string, now = Date.now()): Promise<string> {
  const salt = await saltFor(db, dayOf(now));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${siteId}|${ip}|${ua}`));
  return 'ck' + Array.from(new Uint8Array(digest).slice(0, 15), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deletes salts older than yesterday (yesterday's is kept for visits still open at midnight). */
export function forgetOldSalts(db: D1Database, now = Date.now()) {
  return db.prepare('DELETE FROM cookieless_salts WHERE day < ?').bind(dayOf(now - 86_400_000)).run();
}
