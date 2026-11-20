import { describe, expect, it } from 'vitest';
import { isBusy, retryingD1 } from '../src/worker/lib/d1retry';

const BUSY = 'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.';

/** A stand-in for D1 that turns the first `busy` calls away, and records what batch() was given. */
function fakeD1(busy: number, error = BUSY) {
  let calls = 0;
  const batches: unknown[][] = [];
  const attempt = <T>(v: T) => {
    calls++;
    if (calls <= busy) return Promise.reject(new Error(error));
    return Promise.resolve(v);
  };
  class Stmt {
    constructor(readonly sql: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) {
      return new Stmt(this.sql, args);
    }
    first() {
      return attempt({ sql: this.sql, args: this.args });
    }
    run() {
      return attempt({ success: true });
    }
    all() {
      return attempt({ results: [this.args] });
    }
  }
  const db = {
    prepare: (sql: string) => new Stmt(sql),
    batch: (stmts: unknown[]) => {
      batches.push(stmts);
      return attempt(stmts.map(() => ({ results: [] })));
    },
  };
  return { db: db as unknown as D1Database, calls: () => calls, batches, Stmt };
}

describe('retrying D1', () => {
  it('tries a busy query again and returns its result', async () => {
    const f = fakeD1(2);
    const db = retryingD1(f.db, [0, 0, 0]);
    expect(await db.prepare('SELECT ?').bind(7).first()).toEqual({ sql: 'SELECT ?', args: [7] });
    expect(f.calls()).toBe(3);
  });

  it('gives up after the last retry', async () => {
    const f = fakeD1(10);
    const db = retryingD1(f.db, [0, 0]);
    await expect(db.prepare('SELECT 1').run()).rejects.toThrow(/overloaded/);
    expect(f.calls()).toBe(3);
  });

  it('does not retry other errors', async () => {
    const f = fakeD1(1, 'D1_ERROR: no such table: nope');
    const db = retryingD1(f.db, [0, 0]);
    await expect(db.prepare('SELECT * FROM nope').all()).rejects.toThrow(/no such table/);
    expect(f.calls()).toBe(1);
  });

  it('hands batch() the real statements and retries it', async () => {
    const f = fakeD1(1);
    const db = retryingD1(f.db, [0]);
    await db.batch([db.prepare('SELECT 1'), db.prepare('SELECT ?').bind(2)]);
    expect(f.batches).toHaveLength(2);
    for (const s of f.batches[1]) expect(s).toBeInstanceOf(f.Stmt);
  });

  it('knows both busy messages', () => {
    expect(isBusy(new Error(BUSY))).toBe(true);
    expect(isBusy(new Error('D1 DB is overloaded. Requests queued for too long.'))).toBe(true);
    expect(isBusy(new Error('UNIQUE constraint failed'))).toBe(false);
  });
});
