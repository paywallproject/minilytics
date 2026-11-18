import type { Context } from 'hono';
import { getSite, type AppEnv } from './env';

/**
 * Human check with Cloudflare Turnstile (invisible mode). The tracker opens /api/human/frame in a hidden 1×1 frame
 * once per browser; the frame runs Turnstile on this app's own domain, so Turnstile only ever needs this one
 * hostname and nothing is installed on the sites. The token comes back to /api/human, is validated with Cloudflare
 * and recorded on the visit. Nothing is ever shown to the reader, and a failed check never blocks anyone.
 *
 * Measure-only for now: the result is stored (sessions.human) but doesn't change any numbers.
 */

/** How long a pass lasts: the tracker doesn't re-check a browser that passed within this time (keep in sync with script.js). */
export const HUMAN_PASS_MS = 30 * 86_400_000;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

/** The page inside the hidden frame. Its address is the same for everyone (ids travel in the #fragment), so it caches. */
export function humanFrame(c: Context<AppEnv>) {
  const siteKey = c.env.TURNSTILE_SITE_KEY;
  if (!siteKey || !c.env.TURNSTILE_SECRET) return c.body(null, 404);
  c.header('Cache-Control', 'public, max-age=3600');
  // Embeddable anywhere (it's only ever a hidden frame); scripts only from here and Turnstile.
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; frame-ancestors *",
  );
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Minilytics</title><meta name="robots" content="noindex"></head><body>
<div id="t"></div>
<script>
var p = new URLSearchParams(location.hash.slice(1)), sent = false;
function tell(ok) { try { parent.postMessage({ ml: 'human', ok: ok }, '*'); } catch (e) {} }
function report(extra) {
  if (sent) return;
  sent = true;
  var body = { w: p.get('w'), sid: p.get('sid'), vid: p.get('vid') };
  for (var k in extra) body[k] = extra[k];
  fetch('/api/human', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), keepalive: true })
    .then(function (r) { return r.json(); })
    .then(function (j) { tell(!!j.ok); }, function () { tell(false); });
}
function go() {
  try {
    turnstile.render('#t', {
      sitekey: ${JSON.stringify(siteKey)},
      action: 'visit',
      cData: p.get('sid') || '',
      callback: function (token) { report({ token: token }); },
      'error-callback': function (code) { report({ error: String(code || 'error') }); return true; },
      'timeout-callback': function () { report({ error: 'timeout' }); },
      'unsupported-callback': function () { report({ error: 'unsupported' }); }
    });
  } catch (e) { report({ error: 'render' }); }
}
setTimeout(function () { report({ error: 'timeout' }); }, 25000);
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=go&render=explicit" async defer onerror="report({ error: 'blocked' })"></script>
</body></html>`);
}

/** The frame reports back: validate the token with Cloudflare and record the result on the visit. */
export async function humanResult(c: Context<AppEnv>) {
  const secret = c.env.TURNSTILE_SECRET;
  if (!secret) return c.json({ ok: false }, 404);
  const raw = await c.req.text();
  if (raw.length > 4096) return c.body(null, 413);
  let b: { w?: unknown; sid?: unknown; vid?: unknown; token?: unknown; error?: unknown };
  try {
    b = JSON.parse(raw);
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (!isId(b.w) || !isId(b.sid) || !isId(b.vid)) return c.json({ ok: false }, 400);
  const site = await getSite(c.env.DB, b.w);
  if (!site) return c.json({ ok: false }, 404);

  let detail = typeof b.error === 'string' ? b.error.slice(0, 40) : 'no token';
  // Turnstile doesn't hand a bot a failing token: it reports an error code in the browser instead. 300xxx and
  // 600xxx mean the challenge itself failed (Cloudflare's "probably a bot"), so they count as failed. Anything else
  // (script blocked, timeout, unsupported browser, config) means the check couldn't run.
  let result: 1 | 0 | -1 = /^[36]\d{5}$/.test(detail) ? 0 : -1;
  if (typeof b.token === 'string' && b.token.length < 4096) {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', b.token);
    const ip = c.req.header('cf-connecting-ip');
    if (ip) form.append('remoteip', ip);
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
      const v = (await res.json()) as { success?: boolean; cdata?: string; hostname?: string; 'error-codes'?: string[] };
      // The token must have been made for this very visit (cData = session id).
      result = v.success && v.cdata === b.sid ? 1 : 0;
      detail = result ? 'pass' : (v['error-codes'] ?? []).join(',') || 'mismatch';
    } catch (e) {
      result = -1;
      detail = 'siteverify unreachable';
      console.error('turnstile siteverify failed', e);
    }
  }
  if (result !== 1) console.log('human check', site.domain, result, detail);

  const now = Date.now();
  await c.env.DB.batch([
    // A pass is final for the visit; a failure or error never overwrites a pass.
    c.env.DB.prepare(
      `UPDATE sessions SET human = CASE WHEN human = 1 THEN 1 ELSE ? END,
         human_reason = CASE WHEN human = 1 THEN human_reason ELSE ? END
       WHERE site_id = ? AND id = ? AND visitor_id = ?`,
    ).bind(result, detail.slice(0, 60), site.id, b.sid, b.vid),
    // The visitor row may not exist yet (the pageview can still be on its way, or held until the reader interacts);
    // create it so the pass is kept and carried onto the visit when it's recorded.
    ...(result === 1
      ? [
          c.env.DB.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, b.vid, now),
          c.env.DB.prepare('UPDATE visitors SET human_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, b.vid),
        ]
      : []),
  ]);
  return c.json({ ok: result === 1 });
}
