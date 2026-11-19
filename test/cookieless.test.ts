import { expect, it } from 'vitest';
import { cookielessId, forgetOldSalts } from '../src/worker/lib/cookieless';

/** Just enough of D1 for the salts table. */
function fakeDb() {
  const salts = new Map<string, string>();
  return {
    salts,
    prepare(sql: string) {
      return {
        bind(...args: string[]) {
          return {
            async run() {
              if (sql.startsWith('INSERT OR IGNORE') && !salts.has(args[0])) salts.set(args[0], args[1]);
              if (sql.startsWith('DELETE')) for (const d of [...salts.keys()]) if (d < args[0]) salts.delete(d);
              return { meta: {} };
            },
            async first() { return salts.has(args[0]) ? { salt: salts.get(args[0]) } : null; },
          };
        },
      };
    },
  };
}

it('gives a reader the same id all day, a new one the next day, and a valid event id', async () => {
  const db = fakeDb() as unknown as D1Database;
  const day1 = Date.UTC(2026, 10, 19, 8), later = Date.UTC(2026, 10, 19, 20), day2 = Date.UTC(2026, 10, 20, 8);
  const a = await cookielessId(db, 'site1', '1.2.3.4', 'UA', day1);
  expect(a).toMatch(/^ck[0-9a-f]{30}$/);
  expect(await cookielessId(db, 'site1', '1.2.3.4', 'UA', later)).toBe(a);
  expect(await cookielessId(db, 'site2', '1.2.3.4', 'UA', later)).not.toBe(a);
  expect(await cookielessId(db, 'site1', '1.2.3.5', 'UA', later)).not.toBe(a);
  expect(await cookielessId(db, 'site1', '1.2.3.4', 'UA', day2)).not.toBe(a);
  await forgetOldSalts(db, Date.UTC(2026, 10, 21, 1));
  expect([...(db as any).salts.keys()]).toEqual(['2026-11-20']);
});
