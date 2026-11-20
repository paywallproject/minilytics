import { useState } from 'react';
import { qs } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtDateTime, fmtNumber } from '../lib/format';
import { useApi } from '../lib/useApi';

type Row = { label: string | null; n: number };
interface HeldReport {
  totals: { reason: string; counted: number; n: number }[];
  cameBack: number;
  sample: number;
  botd: { counted: number; label: string; n: number }[];
  releasedHow: Row[];
  notCounted: Record<'network' | 'city' | 'os' | 'page' | 'visible' | 'engaged', Row[]>;
  recent: {
    ts: number;
    reason: string;
    signals: string | null;
    visible: number;
    engaged: number;
    engage_kind: string | null;
    engage_ms: number | null;
    url: string | null;
    meta: { browser?: string; os?: string; device?: string; city?: string; country?: string; network?: string } | null;
  }[];
}

const REASONS: Record<string, string> = {
  automated: 'Automated browser',
  outside_audience: "Country outside the site's readers",
  tz_mismatch: 'Timezone ≠ location',
  old_browser: 'Outdated / incomplete Chrome',
  linux_desktop: 'Linux computer',
  deep_archive: 'Landed deep in archive',
  new_desktop: 'New visit on a computer',
  new_desktop_far: 'New visit on a computer, outside the home region',
};

const path = (u: string | null) => {
  try {
    return u ? new URL(u).pathname : '';
  } catch {
    return u ?? '';
  }
};

/** Admin only: what the proxy-bot hold held back, to check no real readers are among the visits it didn't count. */
export function HeldPanel() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="card mt-5 flex items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-medium">Held as likely bots</div>
          <p className="mt-1 text-xs text-stone-500">Only you and staff see this. Loaded on request: it's a heavy check on busy sites.</p>
        </div>
        <button type="button" className="btn shrink-0 text-xs" onClick={() => setOpen(true)}>
          Show
        </button>
      </div>
    );
  }
  return <HeldReportCard />;
}

function HeldReportCard() {
  const { site, q, reloadKey } = useDash();
  const { data, loading, error } = useApi<HeldReport>(`/api/sites/${site.id}/held?${qs(q)}`, reloadKey);
  if (!data) {
    return <div className="card mt-5 p-4 text-xs text-stone-500">{error ? `Couldn't load the held visits: ${error}` : loading ? 'Loading held visits…' : null}</div>;
  }
  const sum = (counted: number) => data.totals.filter((t) => t.counted === counted).reduce((a, t) => a + t.n, 0);
  const held = sum(0) + sum(1);
  if (!held) return null;
  const list = (title: string, rows: Row[], fmt: (l: string | null) => string = (l) => l ?? '–') => (
    <div>
      <div className="mb-1 text-xs font-medium text-stone-500">{title}</div>
      {rows.slice(0, 8).map((r, i) => (
        <div key={i} className="flex justify-between gap-2 text-xs">
          <span className="truncate">{fmt(r.label)}</span>
          <span className="tabular-nums text-stone-500">{fmtNumber(r.n)}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="card mt-5 p-4">
      <div className="text-sm font-medium">Held as likely bots</div>
      <p className="mt-1 text-xs text-stone-500">
        Only you and staff see this. A new visitor's first visit on a computer, or any first visit that looks automated, waits for a sign
        that someone saw the page (looks automated: interacting plus a few seconds, or 15 seconds on screen; otherwise any interaction or
        time on screen, a second page, a login or a click out). {fmtNumber(held)} were held: {fmtNumber(sum(1))} turned out to be people
        and were counted, {fmtNumber(sum(0))} weren't counted. Of {sum(0) > data.sample ? `the latest ${fmtNumber(data.sample)} of those` : 'those'}, {fmtNumber(data.cameBack)} came back later and were counted then
        (real readers whose first visit was missed; bots don't come back). Check the list below for anything else that looks like a real
        reader.
      </p>
      {sum(0) > data.sample && (
        <p className="mt-1 text-xs text-stone-500">
          Time on screen, interaction, network, place, OS and page cover the latest {fmtNumber(data.sample)} not counted.
        </p>
      )}
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {list('Why held (not counted)', data.totals.filter((t) => !t.counted).map((t) => ({ label: t.reason, n: t.n })), (l) => REASONS[l ?? ''] ?? l ?? '–')}
        {list('Counted after all, because', data.releasedHow)}
        {list('Time on screen (not counted)', data.notCounted.visible)}
        {list('Interaction (not counted)', data.notCounted.engaged)}
        {list('Bot detector (not counted)', data.botd.filter((b) => !b.counted).map((b) => ({ label: b.label, n: b.n })))}
        {list('Bot detector (counted after all)', data.botd.filter((b) => b.counted).map((b) => ({ label: b.label, n: b.n })))}
        {list('Network', data.notCounted.network)}
        {list('Place', data.notCounted.city)}
        {list('OS / browser / device', data.notCounted.os)}
        {list('Page', data.notCounted.page, path)}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-stone-500">Latest 50 not counted</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {data.recent.map((r, i) => (
                <tr key={i} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="whitespace-nowrap py-1 pr-2 text-stone-500">{fmtDateTime(r.ts, site.timezone)}</td>
                  <td className="pr-2">{REASONS[r.reason] ?? r.reason}</td>
                  <td className="pr-2">{[r.meta?.city, r.meta?.country].filter(Boolean).join(', ')}</td>
                  <td className="pr-2">{[r.meta?.os, r.meta?.browser].filter(Boolean).join(' / ')}</td>
                  <td className="pr-2 text-stone-500">{r.meta?.network ?? ''}</td>
                  <td className="pr-2 tabular-nums">{Math.round(r.visible / 1000)}s</td>
                  <td className="pr-2">{r.engaged ? `${r.engage_kind ?? 'interacted'}${r.engage_ms != null ? ` @${r.engage_ms}ms` : ''}` : ''}</td>
                  <td className="max-w-[280px] truncate">{path(r.url)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
