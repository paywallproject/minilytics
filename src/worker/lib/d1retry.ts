/**
 * D1 turns queries away when the database is busy ("D1 DB is overloaded", "Too many resources consumed within a 10
 * second window"). The query never ran, so trying again a moment later is safe, for writes too. Without this a
 * busy moment fails the dashboard panel that asked and, worse, loses the tracked visit that was being saved.
 */

const BUSY = /overloaded|too many resources consumed/i;
/** Waits before each retry; a little random so requests turned away together don't all come back together. */
const WAITS_MS = [200, 700, 1500];

export const isBusy = (e: unknown) => BUSY.test(e instanceof Error ? e.message : String(e));

async function retry<T>(run: () => Promise<T>, waits = WAITS_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= waits.length || !isBusy(e)) throw e;
      await new Promise((r) => setTimeout(r, waits[i] * (0.75 + Math.random() / 2)));
    }
  }
}

// Wrapped statements, mapped back to D1's own so db.batch() gets the real ones.
const real = new WeakMap<object, D1PreparedStatement>();

function wrapStatement(stmt: D1PreparedStatement, waits: number[]): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'bind') return (...args: unknown[]) => wrapStatement(target.bind(...args), waits);
      if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
        return (...args: unknown[]) => retry(() => (target[prop] as (...a: unknown[]) => Promise<unknown>)(...args), waits);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  real.set(wrapped, stmt);
  return wrapped;
}

/** The database, with queries D1 turned away for being busy tried again (up to 3 times, within about 3 seconds). */
export function retryingD1(db: D1Database, waits = WAITS_MS): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql), waits);
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => retry(() => target.batch(stmts.map((s) => real.get(s) ?? s)), waits);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
