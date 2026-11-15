import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mapPlausible, parseCsv, parsePlausibleExport, unzip } from '../src/shared/plausible';
import { cleanRow, importedDays, type SiteImport } from '../src/worker/imports';
import { addImported } from '../src/worker/stats';
import { parseDay } from '../src/worker/lib/time';

/** A minimal zip writer: one deflated entry per file. */
function makeZip(files: Record<string, string>): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...locals, cd, end]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const VISITORS = `"date","visitors","pageviews","bounces","visits","visit_duration"
"2025-03-05",46,66,43,48,1580
"2025-03-06",172,291,139,176,7804
`;
const SOURCES = `"date","source","referrer","utm_source","utm_medium","utm_campaign","utm_content","utm_term","pageviews","visitors","visits","visit_duration","bounces"
"2025-03-05","Bing","bing.com","","","","","",1,1,1,0,1
"2025-03-05","Facebook","m.facebook.com","","","","","",3,2,2,40,1
"2025-03-05","ig","","","","","","",1,1,1,0,1
"2025-03-05","","","","","","","",10,8,9,100,7
"2025-03-05","Newsletter","","newsletter","email","march","","",4,3,3,60,2
`;
const PAGES = `"date","hostname","page","visits","visitors","pageviews"
"2025-03-05","100daysinappalachia.com","/about/",2,2,2
"2025-03-05","100daysinappalachia.com","/about",1,1,1
"2025-03-05","www-100daysinappalachia-com.translate.goog","/about/",1,1,1
`;
const BROWSERS = `"date","browser","browser_version","visitors","visits","visit_duration","bounces","pageviews"
"2025-03-05","Microsoft Edge","133.0",1,1,0,1,1
"2025-03-05","Microsoft Edge","134.0",2,2,10,1,3
"2025-03-05","","",1,1,0,1,1
`;
const EVENTS = `"date","name","link_url","path","visitors","events"
"2025-03-05","Outbound Link: Click","https://example.org/x","",2,3
"2025-03-05","Signup","","",1,1
`;

describe('csv', () => {
  it('handles quotes, escaped quotes and CRLF', () => {
    expect(parseCsv('"a","b"\r\n"x, y","say ""hi"""\r\n1,2\r\n')).toEqual([
      { a: 'x, y', b: 'say "hi"' },
      { a: '1', b: '2' },
    ]);
  });
});

describe('zip', () => {
  it('reads deflated entries', async () => {
    const files = await unzip(makeZip({ 'a.csv': 'hello', 'dir/b.csv': 'world' }));
    expect(new TextDecoder().decode(files.get('dir/b.csv'))).toBe('world');
  });
  it('rejects other files', async () => {
    await expect(unzip(new ArrayBuffer(100))).rejects.toThrow(/not a zip/);
  });
});

describe('plausible mapping', () => {
  const kinds = new Map([
    ['visitors', VISITORS],
    ['sources', SOURCES],
    ['pages', PAGES],
    ['browsers', BROWSERS],
    ['custom_events', EVENTS],
  ]);
  const r = mapPlausible(kinds, '100daysinappalachia.com');
  const find = (dim: string, label: string | null) => r.rows.find((x) => x[1] === dim && x[2] === label);

  it('keeps daily totals and the date range', () => {
    expect(r).toMatchObject({ dateFrom: '2025-03-05', dateTo: '2025-03-06', visitors: 218, pageviews: 357 });
    expect(find('total', null)).toEqual(['2025-03-05', 'total', null, null, 46, 48, 66, 43, 1580]);
  });
  it('classifies sources like live visits', () => {
    expect(find('source', 'Bing')?.[4]).toBe(1);
    expect(find('source', 'Facebook')).toMatchObject({ 3: 'm.facebook.com', 4: 2 });
    expect(find('source', 'Instagram')?.[4]).toBe(1); // Plausible's "ig" source name
    expect(find('source', 'Direct/None')?.[4]).toBe(8);
    expect(find('channel', 'Organic Social')?.[4]).toBe(3);
    expect(find('channel', 'Email')?.[4]).toBe(3);
    expect(find('campaign', 'march')?.[4]).toBe(3);
  });
  it('normalises page paths and drops other hostnames', () => {
    expect(find('page', '/about')).toMatchObject({ 4: 3, 6: 3 });
    expect(r.skippedPages).toBe(1);
  });
  it('maps browser names and merges versions', () => {
    expect(find('browser', 'Edge')).toMatchObject({ 4: 3, 6: 4 });
    expect(find('browser', 'Other')?.[4]).toBe(1);
  });
  it('splits outbound clicks from goals', () => {
    expect(find('exit_link', 'https://example.org/x')).toMatchObject({ 4: 2, 6: 3 });
    expect(find('goal', 'Signup')?.[4]).toBe(1);
  });
  it('reads a whole export zip', async () => {
    const zip = makeZip({ 'imported_visitors_20250305_20250306.csv': VISITORS, 'imported_pages_20250305_20250306.csv': PAGES });
    const p = await parsePlausibleExport(zip, '100daysinappalachia.com');
    expect(p.files).toEqual(['pages', 'visitors']);
    await expect(parsePlausibleExport(makeZip({ 'x.csv': 'a' }), 'x.com')).rejects.toThrow(/Plausible export/);
  });
  it('only accepts well-formed rows on the server', () => {
    expect(cleanRow(['2025-03-05', 'page', '/a', null, 1, 1, 1, 0, -5])).toEqual(['2025-03-05', 'page', '/a', null, 1, 1, 1, 0, 0]);
    expect(cleanRow(['2025-03-05', 'evil', '/a', null, 1, 1, 1, 0, 0])).toBeNull();
    expect(cleanRow(["2025-03-05'; --", 'page', '/a', null, 1, 1, 1, 0, 0])).toBeNull();
  });
});

describe('imported days', () => {
  const tz = 'America/New_York';
  const day = (d: string) => parseDay(d, tz)!;
  const imp: SiteImport = { id: 'i', dateFrom: '2025-03-05', dateTo: '2026-11-15', cutoff: '2026-11-10' };

  it('stops the day before Minilytics started collecting', () => {
    expect(importedDays(imp, day('2026-11-01'), day('2026-11-16'), tz)).toEqual({ first: '2026-11-01', last: '2026-11-09' });
  });
  it('clips to the export and to whole days', () => {
    expect(importedDays(imp, day('2025-01-01'), day('2025-03-07'), tz)).toEqual({ first: '2025-03-05', last: '2025-03-06' });
    expect(importedDays(imp, day('2025-03-05') + 3_600_000, day('2025-03-07'), tz)).toEqual({ first: '2025-03-06', last: '2025-03-06' });
  });
  it('is empty outside the import', () => {
    expect(importedDays(imp, day('2026-11-10'), day('2026-11-12'), tz)).toBeNull();
    expect(importedDays({ ...imp, cutoff: null }, day('2026-11-15'), day('2026-11-16'), tz)).toEqual({ first: '2026-11-15', last: '2026-11-15' });
  });
});

describe('merging breakdowns', () => {
  it('adds imported rows by label and re-ranks', () => {
    const own = [
      { label: 'Google', visitors: 5, pageviews: 6, revenue: 100, customers: 1, extra: 'google.com' },
      { label: 'Paid-only', visitors: 0, revenue: 50, customers: 1 },
    ];
    const rows = addImported(own, [
      { label: 'Facebook', visitors: 20, pageviews: 30, extra: 'facebook.com' },
      { label: 'Google', visitors: 3, pageviews: 4, extra: null },
    ], 10);
    expect(rows.map((r) => [r.label, r.visitors, r.pageviews, r.revenue])).toEqual([
      ['Facebook', 20, 30, 0],
      ['Google', 8, 10, 100],
      ['Paid-only', 0, undefined, 50],
    ]);
  });
});
