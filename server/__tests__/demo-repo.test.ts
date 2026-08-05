import { describe, expect, it } from 'vitest';
import { ensureDemoCustomer, listCustomers, listSitterRoster } from '../db/repo';
import { DEMO_EMAIL } from '../lib/demo';
import { createTestEnv, TENANT_A } from './helpers';

const TENANT_C = 'tnt_pawsandrelax';

describe('ensureDemoCustomer', () => {
  it('provisions customer + pet + owner edge atomically, active, idempotently', async () => {
    const { env, raw } = createTestEnv();
    const first = await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    expect(first.Email).toBe(DEMO_EMAIL);
    expect(first.Status).toBe('active');

    const again = await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    expect(again.Id).toBe(first.Id);

    const users = raw
      .prepare(`SELECT Id, Name, Status FROM EndUsers WHERE TenantId = ? AND Email = ?`)
      .all(TENANT_A, DEMO_EMAIL) as { Id: string; Name: string; Status: string }[];
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ Name: 'Demo Visitor', Status: 'active' });

    const pets = raw
      .prepare(`SELECT Id, Name, PetType FROM EndUserPets WHERE TenantId = ? AND EndUserId = ?`)
      .all(TENANT_A, first.Id) as { Id: string; Name: string; PetType: string }[];
    expect(pets).toHaveLength(1);
    expect(pets[0]).toMatchObject({ Name: 'Biscuit', PetType: 'dog' });

    const edges = raw
      .prepare(`SELECT PetId FROM PetOwners WHERE TenantId = ? AND EndUserId = ?`)
      .all(TENANT_A, first.Id);
    expect(edges).toHaveLength(1);
  });

  it('is per-tenant: provisioning on one tenant creates nothing on another', async () => {
    const { env, raw } = createTestEnv();
    await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_C, DEMO_EMAIL, 'dog');
    const other = raw
      .prepare(`SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = ?`)
      .all(TENANT_A, DEMO_EMAIL);
    expect(other).toEqual([]);
  });
});

describe('demo exclusions', () => {
  it('listCustomers never returns the demo customer; real customers unaffected', async () => {
    const { env } = createTestEnv();
    const before = await listCustomers(env.PAWSERVATION_DB, TENANT_A);
    await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    const after = await listCustomers(env.PAWSERVATION_DB, TENANT_A);
    expect(after).toEqual(before); // jess@example.com still there, demo absent
    expect(after.some((u) => u.Email === DEMO_EMAIL)).toBe(false);
  });

  it('listSitterRoster client counts exclude the demo customer', async () => {
    const { env } = createTestEnv();
    const before = await listSitterRoster(env.PAWSERVATION_DB, null);
    await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    const after = await listSitterRoster(env.PAWSERVATION_DB, null);
    expect(after.map((r) => [r.TenantId, r.Clients])).toEqual(
      before.map((r) => [r.TenantId, r.Clients]),
    );
  });
});
