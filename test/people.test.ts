import { describe, expect, it } from 'vitest';
import { siteAccessSql, siteRole, type User } from '../src/worker/auth';
import type { Env } from '../src/worker/env';
import { validEmail } from '../src/worker/people';

const selfHosted = {} as Env;
const hosted = { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' } as Env;
const user = (id: string, admin = false): User => ({ id, email: null, name: null, avatar: null, admin, paid: true, plan_status: 'active', plan_until: null, plan: null });

describe('site access', () => {
  it('lets the self-hosted admin and staff see every site', () => {
    expect(siteAccessSql(selfHosted, user('admin', true)).sql).toBe('1 = 1');
    expect(siteRole(selfHosted, user('staff1', true), { owner_id: 'client' })).toBe('admin');
  });
  it('gives others their own sites and the ones they were added to', () => {
    const a = siteAccessSql(selfHosted, user('u1'));
    expect(a.sql).toContain('site_members');
    expect(a.params).toEqual(['u1', 'u1']);
    expect(siteRole(selfHosted, user('u1'), { owner_id: 'u1' })).toBe('owner');
    expect(siteRole(selfHosted, user('u1'), { owner_id: 'u2', member_role: 'viewer' })).toBe('viewer');
    expect(siteRole(selfHosted, user('u1'), { owner_id: 'u2', member_role: 'manager' })).toBe('manager');
    expect(siteRole(selfHosted, user('u1'), { owner_id: 'u2', member_role: null })).toBeNull();
    expect(siteRole(selfHosted, user('u1'), { owner_id: null })).toBeNull();
  });
  it('keeps hosted admins on their own and ownerless sites', () => {
    expect(siteAccessSql(hosted, user('h1', true)).sql).toContain('owner_id IS NULL');
    expect(siteRole(hosted, user('h1', true), { owner_id: null })).toBe('owner');
    expect(siteRole(hosted, user('h1', true), { owner_id: 'other' })).toBeNull();
  });
  it('checks emails', () => {
    expect(validEmail('a@b.co')).toBe(true);
    expect(validEmail('nope')).toBe(false);
  });
});
