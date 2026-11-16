import { describe, expect, it } from 'vitest';
import { renderEmail, reportDue, reportPeriod, type ReportData } from '../src/worker/reports';

// Monday 2026-11-16, 13:30 UTC = 08:30 in New York.
const MON_0830_NY = Date.UTC(2026, 10, 16, 13, 30);

describe('report periods', () => {
  it('covers the last full Monday–Sunday week in site time', () => {
    expect(reportPeriod('weekly', 'America/New_York', MON_0830_NY)).toMatchObject({ from: '2026-11-09', to: '2026-11-15', label: 'Nov 9 – 15, 2026' });
    // Wednesday: still last week
    expect(reportPeriod('weekly', 'UTC', Date.UTC(2026, 10, 18, 12)).from).toBe('2026-11-09');
    // A week across months
    expect(reportPeriod('weekly', 'UTC', Date.UTC(2026, 11, 2, 12))).toMatchObject({ from: '2026-11-23', to: '2026-11-29' });
    expect(reportPeriod('weekly', 'UTC', Date.UTC(2026, 9, 5, 12)).label).toBe('Sep 28 – Oct 4, 2026');
  });
  it('covers the last calendar month', () => {
    expect(reportPeriod('monthly', 'UTC', Date.UTC(2026, 10, 16))).toMatchObject({ from: '2026-10-01', to: '2026-10-31', label: 'October 2026' });
    expect(reportPeriod('monthly', 'UTC', Date.UTC(2027, 0, 1, 9))).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });
  it('uses the site timezone for the day boundary', () => {
    // 03:00 UTC Monday is still Sunday evening in New York, so the week before that is reported.
    expect(reportPeriod('weekly', 'America/New_York', Date.UTC(2026, 10, 16, 3)).from).toBe('2026-11-02');
  });
});

describe('when reports go out', () => {
  it('waits until 8am on the first day, then sends once', () => {
    const sevenThirty = MON_0830_NY - 3_600_000;
    expect(reportDue('weekly', 'America/New_York', '2026-11-02', sevenThirty)).toBeNull();
    expect(reportDue('weekly', 'America/New_York', '2026-11-02', MON_0830_NY)?.from).toBe('2026-11-09');
    expect(reportDue('weekly', 'America/New_York', '2026-11-09', MON_0830_NY)).toBeNull();
  });
  it('catches up later in the week if a run was missed', () => {
    expect(reportDue('weekly', 'UTC', '2026-11-02', Date.UTC(2026, 10, 18, 2))?.from).toBe('2026-11-09');
  });
});

const data: ReportData = {
  site: { id: 's1', name: 'Daily <News>', domain: 'news.example', currency: 'USD', timezone: 'UTC' },
  period: { frequency: 'weekly', from: '2026-11-09', to: '2026-11-15', label: 'Nov 9 – 15, 2026' },
  kpis: { visitors: 1200, pageviews: 3400, bounceRate: 0.5, avgDuration: 75, revenue: 12_500, payments: 3, conversionRate: 0.0025 },
  previous: { visitors: 1000, pageviews: 3000, bounceRate: 0.55, avgDuration: 70, revenue: 0, payments: 0, conversionRate: 0 },
  days: ['09', '10', '11', '12', '13', '14', '15'].map((d, i) => ({ date: `2026-11-${d}`, visitors: 100 + i * 20 })),
  sources: [{ label: 'Google', visitors: 600, revenue: 12_500, customers: 3 }],
  pages: [{ label: '/<script>alert(1)</script>', visitors: 300, revenue: 0, customers: 0 }],
  countries: [{ label: 'US', visitors: 900, revenue: 0, customers: 0 }],
  goals: [],
  decimals: 2,
};
const links = { dashboard: 'https://m.example/site/s1', settings: 'https://m.example/account', unsubscribe: 'https://m.example/api/reports/unsubscribe?t=x' };

describe('the email', () => {
  const mail = renderEmail(data, 'Traffic grew about 20%.', links);
  it('has a useful subject and the numbers', () => {
    expect(mail.subject).toBe('Daily <News>: 1,200 visitors last week, $125.00 revenue');
    expect(mail.html).toContain('▲ 20%');
    expect(mail.html).toContain('Traffic grew about 20%.');
    expect(mail.html).toContain('United States');
    expect(mail.text).toContain('Visitors: 1,200 (+20%)');
  });
  it('escapes everything that came from visitors', () => {
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('Daily &lt;News&gt;');
  });
  it('links to the dashboard, settings and unsubscribe', () => {
    expect(mail.html).toContain(links.dashboard);
    expect(mail.html).toContain(links.unsubscribe);
  });
  it('says so when nothing was recorded', () => {
    const quiet = renderEmail({ ...data, kpis: { ...data.kpis, visitors: 0, pageviews: 0, revenue: 0 } }, null, links);
    expect(quiet.html).toContain('No visits were recorded');
  });
});
