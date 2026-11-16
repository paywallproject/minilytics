import { useEffect, useState, type ReactNode } from 'react';
import { SITES_CHANGED } from '../components/NavBar';
import { navigate } from '../App';
import { Favicon } from '../components/Icons';
import { CurrencySelect, TimezoneSelect } from '../components/SiteFields';
import { buildAiPrompt } from '../lib/aiPrompt';
import { api, type Site } from '../lib/api';
import { fmtMoney, fmtNumber } from '../lib/format';
import { parsePlausibleExport, type ImportRow, type ParsedImport } from '../../shared/plausible';

const DOCS = 'https://github.com/surendrapandar/minilytics#';

function Section({ title, desc, docs, children }: { title: string; desc?: ReactNode; docs?: string; children: ReactNode }) {
  return (
    <section className="card p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {docs && <DocsLink anchor={docs} />}
      </div>
      {desc && <p className="mt-1 text-sm text-stone-500">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DocsLink({ anchor, children = 'Docs →' }: { anchor: string; children?: ReactNode }) {
  return (
    <a className="shrink-0 text-sm font-medium text-stone-500 hover:text-ink" href={DOCS + anchor} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const SMALL_BUTTON = 'rounded-md px-2 py-0.5 text-xs font-medium transition';

function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

/** A code block with a small header bar, so the copy button never covers the code. */
function Code({ label, children }: { label?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-stone-900">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-1.5">
        <span className="font-mono text-xs text-stone-400">{label}</span>
        <CopyButton text={children} className={`${SMALL_BUTTON} text-stone-300 hover:bg-white/10 hover:text-white`} />
      </div>
      <code className="code rounded-none">{children}</code>
    </div>
  );
}

/** A single line to copy, e.g. a webhook URL. */
function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{value}</code>
      <CopyButton text={value} className={`${SMALL_BUTTON} border border-stone-200 bg-white hover:bg-stone-100`} />
    </div>
  );
}

function SecretField({ value, configured, onChange, onSave }: { value: string; configured: boolean; onChange: (v: string) => void; onSave: () => void }) {
  return (
    <div>
      <div className="flex gap-2">
        <input className="input font-mono" type="password" placeholder="whsec_..." value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn-dark" onClick={onSave}>
          Save
        </button>
      </div>
      {configured && <p className="mt-1 text-xs text-emerald-600">✓ Connected</p>}
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-5 text-sm">{children}</ol>;
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-600">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p>{title}</p>
        {children}
      </div>
    </li>
  );
}

export function Settings({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [form, setForm] = useState<Partial<Site>>({});
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const origin = window.location.origin;

  useEffect(() => {
    api<Site>(`/api/sites/${siteId}`).then((s) => {
      // View-only access (or someone else's public site): there are no settings to show.
      if (s.readOnly) return navigate(`/site/${siteId}`);
      setSite(s);
      setForm({
        name: s.name,
        domain: s.domain,
        timezone: s.timezone,
        currency: s.currency,
        dodo_webhook_secret: s.dodo_webhook_secret ?? '',
        dodo_product_ids: s.dodo_product_ids ?? '',
        stripe_webhook_secret: s.stripe_webhook_secret ?? '',
        polar_webhook_secret: s.polar_webhook_secret ?? '',
      });
    });
  }, [siteId]);

  async function save(patch: Partial<Site>, msg = 'Saved') {
    setError('');
    try {
      const s = await api<Site>(`/api/sites/${siteId}`, { method: 'PATCH', json: patch });
      setSite(s);
      window.dispatchEvent(new Event(SITES_CHANGED));
      setSaved(msg);
      setTimeout(() => setSaved(''), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!site) return null;
  const set = (patch: Partial<Site>) => setForm({ ...form, ...patch });

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:py-12">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <AiSetup site={site} origin={origin} />

      <Section title="1. Install the script" desc={<>Add it to the <code>&lt;head&gt;</code> of every page on {site.domain}.</>} docs="install-on-a-website">
        <Code label="HTML">{`<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`}</Code>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium text-stone-600">Next.js, and beating ad blockers</summary>
          <div className="mt-3 space-y-3">
            <Code label="app/layout.tsx">{`import Script from 'next/script';

<Script defer data-website-id="${site.id}" src="${origin}/js/script.js" />`}</Code>
            <p className="text-stone-500">Serve the script from your own domain so ad blockers don't stop it:</p>
            <Code label="next.config.js">{`async rewrites() {
  return [
    { source: '/stats/script.js', destination: '${origin}/js/script.js' },
    { source: '/stats/event', destination: '${origin}/api/event' },
  ];
}
// then: <script defer data-website-id="${site.id}" data-api="/stats/event" src="/stats/script.js"></script>`}</Code>
          </div>
        </details>
        <p className="mt-3 text-sm text-stone-500">
          Your own visits aren't counted from any browser you've opened this dashboard in. For other devices (like your phone), open{' '}
          <code>{site.domain}/?ml_ignore=true</code> once.
        </p>
      </Section>

      <Section title="2. Track goals" desc="Button clicks and key actions, shown in the Goals tab." docs="install-on-a-website">
        <Code label="HTML / JS">{`<button data-ml-goal="signup">Get started</button>

window.minilytics('goal', 'signup', { plan: 'pro' });
window.minilytics('identify', { email: user.email, name: user.name });`}</Code>
      </Section>

      <Revenue site={site} origin={origin} form={form} set={set} save={save} onKeyRotated={(api_key) => setSite({ ...site, api_key })} />

      <LinkBuilder domain={site.domain} />

      <PlausibleImport site={site} />

      <PublicDashboard site={site} origin={origin} onChange={(on) => save({ public: on ? 1 : 0 }, on ? 'Dashboard is public' : 'Dashboard is private')} />

      <Section title="General">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input className="input" value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div>
            <label className="label">Domain</label>
            <input className="input" value={form.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} />
          </div>
          <div>
            <label className="label">Timezone</label>
            <TimezoneSelect value={form.timezone ?? 'UTC'} onChange={(timezone) => set({ timezone })} />
          </div>
          <div>
            <label className="label">Revenue currency</label>
            <CurrencySelect value={form.currency ?? 'USD'} onChange={(currency) => set({ currency })} />
          </div>
        </div>
        <button className="btn-dark mt-4" onClick={() => save({ name: form.name, domain: form.domain, timezone: form.timezone, currency: form.currency })}>
          Save changes
        </button>
      </Section>

      {(saved || error) && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-xl px-4 py-2 text-sm text-white shadow-lg ${error ? 'bg-red-600' : 'bg-ink'}`}>
          {error || saved}
        </div>
      )}

      <People site={site} onOwnerRemoved={() => setSite({ ...site, owner_id: null })} onOwnerChanged={(owner_id) => setSite({ ...site, owner_id })} />

      {site.role === 'admin' && <ClientOwner site={site} onChange={(owner_id) => setSite({ ...site, owner_id })} />}

      <Reports site={site} />

      {site.role !== 'manager' && (
        <Section title="Danger zone">
          <button
            className="btn border-red-200 text-red-600"
            onClick={async () => {
              if (prompt(`Type ${site.domain} to delete this site and all of its data`) !== site.domain) return;
              await api(`/api/sites/${siteId}`, { method: 'DELETE' });
              navigate('/');
            }}
          >
            Delete site and all data
          </button>
        </Section>
      )}
    </div>
  );
}

interface Person {
  id: string;
  email: string;
  role: 'viewer' | 'manager';
  /** Their email report for this site. */
  report?: 'weekly' | 'monthly' | null;
}

type ReportFrequency = 'off' | 'weekly' | 'monthly';

/** Admin only: someone's email report for this site. */
function PersonReport({ siteId, person, onError }: { siteId: string; person: { id: string; email: string; report?: string | null }; onError: (m: string) => void }) {
  const [value, setValue] = useState<ReportFrequency>((person.report as ReportFrequency) ?? 'off');
  useEffect(() => setValue((person.report as ReportFrequency) ?? 'off'), [person.report]);
  return (
    <select
      className="input w-auto py-1 text-stone-600"
      value={value}
      title="Email report"
      aria-label={`Email report for ${person.email}`}
      onChange={async (e) => {
        const next = e.target.value as ReportFrequency;
        const prev = value;
        setValue(next);
        try {
          await api(`/api/sites/${siteId}/people/${person.id}/report`, { method: 'PUT', json: { frequency: next } });
        } catch (err) {
          setValue(prev);
          onError((err as Error).message);
        }
      }}
    >
      <option value="off">No report</option>
      <option value="weekly">Weekly report</option>
      <option value="monthly">Monthly report</option>
    </select>
  );
}

/** Email reports: what they look like, and a test send. Each person picks their own in Account. */
function Reports({ site }: { site: Site }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ to: string; summary: boolean }>(`/api/sites/${site.id}/report/test`, { method: 'POST', json: { frequency: 'weekly' } });
      setMsg({ ok: true, text: `Sent to ${r.to}.${r.summary ? '' : ' (Without the written summary: the Claude API key isn’t set up.)'}` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Email reports"
      desc={
        <>
          A weekly or monthly email with a short written summary of how the site did, the key numbers and its top sources, pages and countries. Each
          person turns theirs on or off in <a className="underline" href="/account" onClick={(e) => (e.preventDefault(), navigate('/account'))}>Account</a>
          {site.role === 'admin' ? ', and you can set anyone’s in People above' : ''}.
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        <a className="btn" href={`/api/sites/${site.id}/report/preview?frequency=weekly`} target="_blank" rel="noreferrer">
          Preview weekly
        </a>
        <a className="btn" href={`/api/sites/${site.id}/report/preview?frequency=monthly`} target="_blank" rel="noreferrer">
          Preview monthly
        </a>
        <button className="btn-dark" onClick={test} disabled={busy}>
          {busy ? 'Sending…' : 'Email me a test'}
        </button>
      </div>
      {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>}
    </Section>
  );
}

/** A new login's temporary password, shown once to whoever created it. */
export function NewLogin({ email, password, onDone }: { email: string; password: string | null; onDone: () => void }) {
  const origin = window.location.origin;
  const text = password
    ? `Your analytics dashboard: ${origin}\nLog in with ${email} and this temporary password: ${password}\nPlease change it after logging in (account menu → Account & password).`
    : `${email} already had a login, so they can use it: ${origin}`;
  return (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
      <p className="font-medium text-emerald-900">{password ? 'Login created. Send them this (the password is only shown now):' : 'Done.'}</p>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-white p-3 font-mono text-xs text-stone-700">{text}</pre>
      <div className="mt-2 flex gap-2">
        {password && <CopyButton text={text} label="Copy message" />}
        <button className="btn py-1.5 text-sm" onClick={onDone}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Who else can log in to see this site. */
function People({ site, onOwnerRemoved, onOwnerChanged }: { site: Site; onOwnerRemoved: () => void; onOwnerChanged: (ownerId: string) => void }) {
  const [data, setData] = useState<{ owner: { id: string; email: string; report?: Person['report'] } | null; members: Person[] } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Person['role']>('viewer');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<typeof data>(`/api/sites/${site.id}/people`).then(setData).catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, [site.id, site.owner_id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Admin only: take the site off its owner. It goes back into the admin account; their login stays.
   * With `keepAs` they stay on the site as a manager or viewer instead of losing access.
   */
  async function removeOwner(keepAs?: Person['role']) {
    const who = data?.owner?.email ?? 'the owner';
    const msg = keepAs
      ? `Change ${who} from owner to ${keepAs} of ${site.domain}? The site goes back into the admin account, and they keep ${keepAs} access.`
      : `Remove ${who} as owner of ${site.domain}? They lose access and the site goes back into the admin account. Their login isn't deleted, and other people on the site keep their access.`;
    if (!confirm(msg)) return;
    setError('');
    try {
      await api(`/api/sites/${site.id}/transfer`, { method: 'DELETE', json: keepAs ? { keepAs } : {} });
      onOwnerRemoved();
      window.dispatchEvent(new Event(SITES_CHANGED));
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Admin only: make someone already on the site its owner. The current owner (if any) stays on as a manager. */
  async function makeOwner(p: Person) {
    const current = site.owner_id ? data?.owner?.email : null;
    if (!confirm(`Make ${p.email} the owner of ${site.domain}?${current ? ` ${current} stays on the site as a manager.` : ''}`)) return;
    setError('');
    try {
      const r = await api<{ owner: { id: string } }>(`/api/sites/${site.id}/transfer`, { method: 'POST', json: { email: p.email, keepPreviousAs: 'manager' } });
      onOwnerChanged(r.owner.id);
      window.dispatchEvent(new Event(SITES_CHANGED));
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api<{ email: string; password: string | null }>(`/api/sites/${site.id}/people`, { method: 'POST', json: { email, role } });
      setCreated(r);
      setEmail('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function change(p: Person, next: Person['role'] | null) {
    setError('');
    try {
      if (next) await api(`/api/sites/${site.id}/people/${p.id}`, { method: 'PATCH', json: { role: next } });
      else if (confirm(`Remove ${p.email}'s access to ${site.domain}?`)) await api(`/api/sites/${site.id}/people/${p.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Section title="People" desc="Give others their own login to this site. Viewers see the dashboard; managers can also change settings.">
      <ul className="divide-y divide-stone-100 text-sm">
        <li className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1 truncate">{site.owner_id ? data?.owner?.email ?? '…' : 'Admin'}</span>
          {site.role === 'admin' && data?.owner && <PersonReport siteId={site.id} person={data.owner} onError={setError} />}
          {site.role === 'admin' && site.owner_id ? (
            <>
              <select
                className="input w-auto py-1"
                value="owner"
                onChange={(e) => e.target.value !== 'owner' && removeOwner(e.target.value as Person['role'])}
                aria-label="Owner's level"
              >
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="viewer">Viewer</option>
              </select>
              <button className="text-stone-400 hover:text-red-600" onClick={() => removeOwner()} aria-label="Remove owner" title="Remove owner">
                ✕
              </button>
            </>
          ) : (
            <span className="text-stone-500">Owner</span>
          )}
        </li>
        {data?.members.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate">{p.email}</span>
            {site.role === 'admin' && <PersonReport siteId={site.id} person={p} onError={setError} />}
            <select
              className="input w-auto py-1"
              value={p.role}
              onChange={(e) => (e.target.value === 'owner' ? makeOwner(p) : change(p, e.target.value as Person['role']))}
              aria-label={`Role for ${p.email}`}
            >
              {site.role === 'admin' && <option value="owner">Owner</option>}
              <option value="manager">Manager</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="text-stone-400 hover:text-red-600" onClick={() => change(p, null)} aria-label={`Remove ${p.email}`} title="Remove">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-4 flex flex-wrap gap-2">
        <input className="input min-w-0 flex-1" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
        <select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value as Person['role'])} aria-label="Role">
          <option value="viewer">Viewer</option>
          <option value="manager">Manager</option>
        </select>
        <button className="btn-dark" disabled={busy || !email}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {created && <NewLogin {...created} onDone={() => setCreated(null)} />}
    </Section>
  );
}

/** Admin only: hand this site to a client (they become the owner), or take it back. Data and tracking stay as they are. */
function ClientOwner({ site, onChange }: { site: Site; onChange: (ownerId: string | null) => void }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(`Make ${email} the owner of ${site.domain}? You'll still see it.`)) return;
    setError('');
    setBusy(true);
    try {
      const r = await api<{ owner: { id: string; email: string; password: string | null } }>(`/api/sites/${site.id}/transfer`, { method: 'POST', json: { email } });
      setCreated(r.owner);
      setEmail('');
      onChange(r.owner.id);
      window.dispatchEvent(new Event(SITES_CHANGED));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function takeBack() {
    if (!confirm(`Take ${site.domain} back into the admin account? The current owner loses access (people added to the site keep theirs).`)) return;
    setError('');
    try {
      await api(`/api/sites/${site.id}/transfer`, { method: 'DELETE' });
      onChange(null);
      window.dispatchEvent(new Event(SITES_CHANGED));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Section
      title="Client"
      desc="Move this site to a client: they get their own login and become its owner. The tracking script, data and imports stay as they are, and you keep full access."
    >
      <form onSubmit={move} className="flex flex-wrap gap-2">
        <input className="input min-w-0 flex-1" type="email" placeholder="client@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Client email" />
        <button className="btn-dark" disabled={busy || !email}>
          {busy ? 'Moving…' : site.owner_id ? 'Change owner' : 'Move to client'}
        </button>
      </form>
      {site.owner_id && (
        <button className="mt-3 text-sm text-stone-500 underline-offset-2 hover:underline" onClick={takeBack}>
          Take it back into the admin account
        </button>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {created && <NewLogin {...created} onDone={() => setCreated(null)} />}
    </Section>
  );
}

interface ImportInfo {
  id: string;
  status: 'importing' | 'done';
  date_from: string;
  date_to: string;
  rows_total: number;
  rows_done: number;
  created_at: number;
}

const CHUNK = 5000;

/** Bring over history from a Plausible CSV export. The zip is read in the browser and sent in chunks. */
function PlausibleImport({ site }: { site: Site }) {
  const [current, setCurrent] = useState<ImportInfo | null>(null);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState<'' | 'reading' | 'uploading' | 'removing'>('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const load = () => api<ImportInfo | null>(`/api/sites/${site.id}/import`).then(setCurrent).catch(() => {});
  useEffect(() => {
    load();
  }, [site.id]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError('');
    setParsed(null);
    setFileName(file.name);
    setBusy('reading');
    try {
      setParsed(await parsePlausibleExport(await file.arrayBuffer(), site.domain));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function upload(p: ParsedImport) {
    setError('');
    setBusy('uploading');
    setProgress(0);
    try {
      const { id } = await api<{ id: string }>(`/api/sites/${site.id}/import`, {
        method: 'POST',
        json: { source: 'plausible', date_from: p.dateFrom, date_to: p.dateTo, rows: p.rows.length },
      });
      for (let i = 0; i < p.rows.length; i += CHUNK) {
        await sendChunk(id, p.rows.slice(i, i + CHUNK));
        setProgress(Math.min(1, (i + CHUNK) / p.rows.length));
      }
      await api(`/api/sites/${site.id}/import/${id}/finish`, { method: 'POST' });
      setParsed(null);
      await load();
    } catch (e) {
      setError(`The import stopped: ${(e as Error).message}. Your previous data is unchanged; try again.`);
    } finally {
      setBusy('');
    }
  }

  async function sendChunk(id: string, rows: ImportRow[]) {
    // One retry covers a dropped connection mid-import.
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(`/api/sites/${site.id}/import/${id}/rows`, { method: 'POST', json: { rows } });
      } catch (e) {
        if (attempt >= 1) throw e;
      }
    }
  }

  async function remove() {
    if (!confirm('Remove the imported Plausible data from this site? Data Minilytics collected itself is kept.')) return;
    setBusy('removing');
    try {
      await api(`/api/sites/${site.id}/import`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const done = current?.status === 'done' ? current : null;
  // Plausible names the export after the site, e.g. example_com_20261115.zip.
  const otherSite = fileName && !fileName.startsWith(site.domain.replace(/\./g, '_') + '_');

  return (
    <Section
      title="Import from Plausible"
      desc={
        <>
          Bring over your history. In Plausible, open <b>Site settings → Imports &amp; Exports → Export data</b> and upload the zip you get by email.
        </>
      }
    >
      {done && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
          <span>
            ✓ Plausible data from <b>{done.date_from}</b> to <b>{done.date_to}</b> is imported.
          </span>
          <button className="btn" disabled={!!busy} onClick={remove}>
            {busy === 'removing' ? 'Removing…' : 'Remove'}
          </button>
        </div>
      )}

      {!parsed && (
        <label className={`btn cursor-pointer ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          {busy === 'reading' ? 'Reading the export…' : done ? 'Import a new export (replaces this one)' : 'Choose Plausible export (.zip)'}
          <input type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => pick(e.target.files?.[0])} onClick={(e) => ((e.target as HTMLInputElement).value = '')} />
        </label>
      )}

      {parsed && (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl border border-stone-200 px-4 py-3">
            <p>
              <b>{fmtNumber(parsed.visitors)}</b> visitors and <b>{fmtNumber(parsed.pageviews)}</b> pageviews from <b>{parsed.dateFrom}</b> to{' '}
              <b>{parsed.dateTo}</b>.
            </p>
            {parsed.skippedPages > 0 && (
              <p className="mt-1 text-stone-500">
                {fmtNumber(parsed.skippedPages)} page rows on other hostnames (copies of the site, translation proxies) are left out, as live tracking does.
              </p>
            )}
            {otherSite && <p className="mt-1 text-amber-700">This file's name doesn't match {site.domain}. Make sure it's the right site's export.</p>}
          </div>
          {busy === 'uploading' ? (
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-stone-100">
                <div className="h-full bg-ink transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <p className="mt-1 text-stone-500">Importing… {Math.round(progress * 100)}%. Keep this page open.</p>
            </div>
          ) : (
            <div className="flex gap-2">
              <button className="btn-dark" onClick={() => upload(parsed)}>
                Import
              </button>
              <button className="btn" onClick={() => setParsed(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium text-stone-600">What gets imported</summary>
        <div className="mt-2 space-y-2 text-stone-500">
          <p>
            Visitors, pageviews, bounce rate and session time, plus channels, referrers, campaigns, pages, entry pages, countries, browsers, OS,
            devices and custom events. Imported days fill the dashboard up to the day Minilytics started collecting, so no day is counted twice.
          </p>
          <p>
            Plausible exports daily totals, not individual visits. So imported history has no revenue attribution, visitor profiles, journeys or
            funnels; it's hidden while a filter is on; and over multi-day periods someone who visited on two days counts as two visitors.
          </p>
        </div>
      </details>
    </Section>
  );
}

/** Share the dashboard: anyone with the link sees it (not these settings) without logging in. */
function PublicDashboard({ site, origin, onChange }: { site: Site; origin: string; onChange: (on: boolean) => void }) {
  const on = !!site.public;
  const link = `${origin}/site/${site.id}`;
  return (
    <Section
      title="Public dashboard"
      desc="Anyone with the link can see this dashboard without logging in, including customers, visitor profiles and live view. Settings stay private."
    >
      <label className="flex cursor-pointer items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(!on)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-ink' : 'bg-stone-300'}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <span className="text-sm font-medium">{on ? 'Public' : 'Private'}</span>
      </label>
      {on && (
        <div className="mt-4">
          <CopyField value={link} />
        </div>
      )}
    </Section>
  );
}

type Provider = 'dodo' | 'stripe' | 'polar' | 'paywallproject' | 'api';

interface RevenueProps {
  site: Site;
  origin: string;
  form: Partial<Site>;
  set: (patch: Partial<Site>) => void;
  save: (patch: Partial<Site>, msg?: string) => Promise<void>;
  onKeyRotated: (key: string) => void;
}

/** Revenue attribution: pick the payment provider, see only its setup. */
function Revenue(props: RevenueProps) {
  const { site } = props;
  const [provider, setProvider] = useState<Provider>(
    site.dodo_webhook_secret ? 'dodo' : site.stripe_webhook_secret ? 'stripe' : site.polar_webhook_secret ? 'polar' : 'dodo',
  );
  const tabs: { id: Provider; label: string; icon: ReactNode; connected?: boolean }[] = [
    { id: 'dodo', label: 'Dodo Payments', icon: <Favicon domain="dodopayments.com" size={18} />, connected: !!site.dodo_webhook_secret },
    { id: 'stripe', label: 'Stripe', icon: <Favicon domain="stripe.com" size={18} />, connected: !!site.stripe_webhook_secret },
    { id: 'polar', label: 'Polar', icon: <Favicon domain="polar.sh" size={18} />, connected: !!site.polar_webhook_secret },
    { id: 'paywallproject', label: 'PaywallProject', icon: <Favicon domain="paywallproject.com" size={18} /> },
    { id: 'api', label: 'Other / API', icon: <span className="font-mono text-xs text-stone-500">{'{ }'}</span> },
  ];
  return (
    <Section title="3. Connect payments" desc="Each payment is linked to the visitor who paid and the source that brought them.">
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setProvider(t.id)}
            className={`relative flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
              provider === t.id ? 'border-ink bg-stone-50 ring-1 ring-ink' : 'border-stone-200 text-stone-600 hover:bg-stone-50'
            }`}
          >
            {t.icon}
            <span className="truncate">{t.label}</span>
            {t.connected && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-emerald-500" title="Connected" />}
          </button>
        ))}
      </div>
      {provider === 'dodo' && <DodoSetup {...props} />}
      {provider === 'stripe' && <StripeSetup {...props} />}
      {provider === 'polar' && <PolarSetup {...props} />}
      {provider === 'paywallproject' && <PaywallProjectSetup {...props} />}
      {provider === 'api' && <ApiSetup {...props} />}
    </Section>
  );
}

function DodoSetup({ site, origin, form, set, save }: RevenueProps) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Dodo → <b>Developer → Webhooks</b>, add this endpoint with <code>payment.succeeded</code> and <code>refund.succeeded</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/dodo/${site.id}`} />
        </Step>
        <Step n={2} title="Paste its signing secret:">
          <SecretField
            value={form.dodo_webhook_secret ?? ''}
            configured={!!site.dodo_webhook_secret}
            onChange={(v) => set({ dodo_webhook_secret: v })}
            onSave={() => save({ dodo_webhook_secret: form.dodo_webhook_secret ?? '' }, 'Dodo connected')}
          />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout. Payment links need nothing, the script tags them.">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await dodo.checkoutSessions.create({
  // ...your existing options
  return_url: 'https://${site.domain}/thanks',
  metadata: {
    ml_visitor_id: jar.get('ml_vid')?.value ?? '',
    ml_session_id: jar.get('ml_sid')?.value ?? '',
  },
});`}</Code>
        </Step>
      </Steps>
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer font-medium text-stone-600">Selling other products from the same Dodo account?</summary>
        <p className="mt-2 text-stone-500">List this site's product ids so only their payments count.</p>
        <div className="mt-2 flex gap-2">
          <input
            className="input font-mono"
            placeholder="pdt_abc123, pdt_def456"
            value={form.dodo_product_ids ?? ''}
            onChange={(e) => set({ dodo_product_ids: e.target.value })}
          />
          <button className="btn-dark" onClick={() => save({ dodo_product_ids: form.dodo_product_ids ?? '' }, 'Products saved')}>
            Save
          </button>
        </div>
      </details>
      <PendingDodoPayments site={site} />
      <ProviderFooter anchor="dodo-payments" />
    </>
  );
}

const currencyDecimals = (c: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

interface PendingProduct {
  product_id: string | null;
  count: number;
  amount: number;
  currency: string | null;
}

/** Payments from a product Minilytics couldn't link to any site yet. Rare: most are placed automatically. */
function PendingDodoPayments({ site }: { site: Site }) {
  const [rows, setRows] = useState<PendingProduct[]>([]);
  const load = () => api<PendingProduct[]>(`/api/sites/${site.id}/pending-payments`).then(setRows);
  useEffect(() => {
    load();
  }, [site.id]);
  if (!rows.length) return null;
  return (
    <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      <p className="font-medium text-amber-900">Payments waiting for a site</p>
      <p className="mt-1 text-amber-800">
        These came from a product none of your sites links to yet, so they aren't counted anywhere. They're placed automatically once a buyer
        comes from {site.name}. Know they're {site.name}'s? Count them now.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={r.product_id ?? ''} className="flex items-center justify-between gap-3">
            <span>
              <code>{r.product_id ?? 'unknown product'}</code> · {r.count} payment{r.count === 1 ? '' : 's'},{' '}
              {fmtMoney(r.amount, r.currency ?? site.currency, currencyDecimals(r.currency ?? site.currency))}
            </span>
            {r.product_id && (
              <button
                className="btn shrink-0"
                onClick={() => api(`/api/sites/${site.id}/pending-payments`, { method: 'POST', json: { product_id: r.product_id } }).then(load)}
              >
                Count for {site.name}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StripeSetup({ site, origin, form, set, save }: RevenueProps) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Stripe → <b>Developers → Webhooks</b>, add this endpoint with <code>checkout.session.completed</code>,{' '}
              <code>invoice.paid</code> and <code>charge.refunded</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/stripe/${site.id}`} />
        </Step>
        <Step n={2} title="Paste its signing secret:">
          <SecretField
            value={form.stripe_webhook_secret ?? ''}
            configured={!!site.stripe_webhook_secret}
            onChange={(v) => set({ stripe_webhook_secret: v })}
            onSave={() => save({ stripe_webhook_secret: form.stripe_webhook_secret ?? '' }, 'Stripe connected')}
          />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout:">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await stripe.checkout.sessions.create({
  // ...your existing options
  success_url: 'https://${site.domain}/thanks?session_id={CHECKOUT_SESSION_ID}',
  metadata: {
    ml_visitor_id: jar.get('ml_vid')?.value ?? '',
    ml_session_id: jar.get('ml_sid')?.value ?? '',
    ml_site_id: '${site.id}', // only needed if one Stripe account sells for several sites
  },
});`}</Code>
          <p className="text-stone-500">
            Using <b>Payment Links</b>? No code needed. Set the link's confirmation page to redirect to{' '}
            <code>https://{site.domain}/thanks?session_id={'{CHECKOUT_SESSION_ID}'}</code>.
          </p>
        </Step>
      </Steps>
      <ProviderFooter anchor="stripe" />
    </>
  );
}

function PolarSetup({ site, origin, form, set, save }: RevenueProps) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Polar → <b>Settings → Webhooks</b>, add this endpoint (format: Raw) with <code>order.paid</code>,{' '}
              <code>refund.created</code> and <code>refund.updated</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/polar/${site.id}`} />
        </Step>
        <Step n={2} title="Paste its signing secret:">
          <SecretField
            value={form.polar_webhook_secret ?? ''}
            configured={!!site.polar_webhook_secret}
            onChange={(v) => set({ polar_webhook_secret: v })}
            onSave={() => save({ polar_webhook_secret: form.polar_webhook_secret ?? '' }, 'Polar connected')}
          />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout, as metadata and customer metadata:">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers
const ml = {
  ml_visitor_id: jar.get('ml_vid')?.value ?? '',
  ml_session_id: jar.get('ml_sid')?.value ?? '',
};

await polar.checkouts.create({
  // ...your existing options
  success_url: 'https://${site.domain}/checkout/complete?checkout_id={CHECKOUT_ID}',
  metadata: ml,
  customer_metadata: ml,
});`}</Code>
          <p className="text-stone-500">
            Using <b>checkout links</b> (buy.polar.sh)? The script sets <code>reference_id</code> to the visitor. Also set the success URL to{' '}
            <code>https://{site.domain}/checkout/complete?checkout_id={'{CHECKOUT_ID}'}</code>.
          </p>
        </Step>
      </Steps>
      <ProviderFooter anchor="polar" />
    </>
  );
}

function PaywallProjectSetup({ site, origin }: RevenueProps) {
  return (
    <>
      <p className="mb-3 text-sm text-stone-500">
        The PaywallProject WordPress plugin sends every membership payment, renewal and refund here, and adds the tracking script for
        you.
      </p>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li>
          In WordPress, open <b>Paywall Project → Settings → Minilytics</b> and tick <b>Enable Minilytics</b>.
        </li>
        <li>
          Fill in these values and save:
          <div className="mt-2">
            <Code>{`Minilytics address: ${origin}
Website ID:         ${site.id}
API key:            ${site.api_key}`}</Code>
          </div>
        </li>
        <li>
          If the tracking script is already on the site another way, untick <b>Add the Minilytics tracking script to every page</b> there so visits aren't counted
          twice.
        </li>
      </ol>
    </>
  );
}

function ApiSetup({ site, origin, onKeyRotated }: RevenueProps) {
  return (
    <>
      <p className="mb-3 text-sm text-stone-500">Any other provider: send payments from your backend with this site's API key.</p>
      <div className="mb-4 flex gap-2">
        <input className="input font-mono" readOnly value={site.api_key} />
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Rotate the API key? The old key stops working immediately.')) return;
            const r = await api<{ api_key: string }>(`/api/sites/${site.id}/rotate-key`, { method: 'POST' });
            onKeyRotated(r.api_key);
          }}
        >
          Rotate
        </button>
      </div>
      <Code label="POST /api/v1/payments">{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "transaction_id": "txn_123",
    "amount": 29.99,
    "currency": "${site.currency}",
    "visitor_id": "<ml_vid cookie>",
    "email": "jane@acme.com"
  }'`}</Code>
      <ProviderFooter anchor="other-providers-api" note="Refunds, renewals and server-side goals are covered in the guide." />
    </>
  );
}

function ProviderFooter({ anchor, note = 'No metadata? Payments are still matched by return page, email or timing.' }: { anchor: string; note?: string }) {
  return (
    <p className="mt-5 border-t border-stone-100 pt-4 text-sm text-stone-500">
      {note} <DocsLink anchor={anchor}>Full guide →</DocsLink>
    </p>
  );
}

/** One-click prompt for the owner's coding AI, so it can install everything in their codebase. */
function AiSetup({ site, origin }: { site: Site; origin: string }) {
  const [open, setOpen] = useState(false);
  const prompt = buildAiPrompt(site, origin);
  return (
    <section className="card border-violet-200 bg-gradient-to-br from-violet-50 to-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">✨ Set up with AI</h2>
          <p className="mt-1 text-sm text-stone-600">Paste into Claude Code or Cursor in your project. It does steps 1–3 for you.</p>
        </div>
        <CopyButton text={prompt} label="Copy AI prompt" className="btn-dark shrink-0" />
      </div>
      <button className="mt-3 text-sm font-medium text-violet-700 hover:underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide prompt' : 'Preview prompt'}
      </button>
      {open && <pre className="code mt-3 max-h-96 whitespace-pre-wrap">{prompt}</pre>}
    </section>
  );
}

const PRESETS = [
  { label: 'X / Twitter', source: 'x', medium: 'social' },
  { label: 'LinkedIn', source: 'linkedin', medium: 'social' },
  { label: 'Reddit', source: 'reddit', medium: 'social' },
  { label: 'YouTube', source: 'youtube', medium: 'video' },
  { label: 'Medium', source: 'medium', medium: 'article' },
  { label: 'Newsletter', source: 'newsletter', medium: 'email' },
  { label: 'Product Hunt', source: 'producthunt', medium: 'referral' },
];

/** Build a tagged link per tweet / article, so each one shows up separately in Campaign. */
function LinkBuilder({ domain }: { domain: string }) {
  const [url, setUrl] = useState(`https://${domain}/`);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [campaign, setCampaign] = useState('');
  let built = '';
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', preset.source);
    u.searchParams.set('utm_medium', preset.medium);
    if (campaign) u.searchParams.set('utm_campaign', campaign.trim().toLowerCase().replace(/\s+/g, '-'));
    built = u.toString();
  } catch {}
  return (
    <Section title="Link builder" desc="Tag the link in each post to see which one brought visitors and revenue (Referrer → Campaign)." docs="tracking-a-specific-tweet--article">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <label className="label">Page</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="label">Where you post it</label>
          <select className="input" value={preset.label} onChange={(e) => setPreset(PRESETS.find((p) => p.label === e.target.value)!)}>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Post name</label>
          <input className="input" placeholder="launch-tweet" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
        </div>
      </div>
      {built && (
        <div className="mt-4">
          <CopyField value={built} />
        </div>
      )}
    </Section>
  );
}
