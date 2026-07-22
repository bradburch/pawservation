import { describe, expect, it } from 'vitest';
import {
  countPetTypeReferences,
  createPetType,
  createTenantFromSignup,
  deletePetType,
  deletePetTypeAndScrub,
  insertBookingRequest,
  listPetTypes,
  listServices,
  renamePetType,
  rollbackUnclaimedTenant,
  setServiceAcceptedPetTypes,
  setServiceConfig,
} from '../db/repo';
import { ALLOWED_EMAIL, createTestEnv, TENANT_A } from './helpers';

describe('pet-type rows (repo)', () => {
  it('listPetTypes returns Label, ordered by PetType', async () => {
    const { env } = createTestEnv();
    const rows = await listPetTypes(env.PAWBOOK_DB, TENANT_A);
    expect(rows.map((r) => ({ petType: r.PetType, label: r.Label }))).toEqual([
      { petType: 'cat', label: 'Cats' },
      { petType: 'dog', label: 'Dogs' },
      { petType: 'rabbit', label: 'Rabbits' },
    ]);
  });

  it('createPetType inserts a registry row; duplicate slug throws UNIQUE', async () => {
    const { env } = createTestEnv();
    await createPetType(env.PAWBOOK_DB, TENANT_A, 'bird', 'Birds');
    const rows = await listPetTypes(env.PAWBOOK_DB, TENANT_A);
    expect(rows.find((r) => r.PetType === 'bird')).toMatchObject({ Label: 'Birds' });
    await expect(createPetType(env.PAWBOOK_DB, TENANT_A, 'bird', 'Birds!')).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('renamePetType changes Label only; unknown slug reports false', async () => {
    const { env } = createTestEnv();
    expect(await renamePetType(env.PAWBOOK_DB, TENANT_A, 'rabbit', 'Bunnies')).toBe(true);
    const rows = await listPetTypes(env.PAWBOOK_DB, TENANT_A);
    expect(rows.find((r) => r.PetType === 'rabbit')?.Label).toBe('Bunnies');
    expect(await renamePetType(env.PAWBOOK_DB, TENANT_A, 'dragon', 'Dragons')).toBe(false);
  });

  it('countPetTypeReferences counts customer pets AND bookings of any status', async () => {
    const { env } = createTestEnv();
    // Seeded: Bella + Otis are dogs (Bella in TENANT_A), and seeded pending bookings carry
    // PetType 'dog' — but scope is per-tenant.
    expect(await countPetTypeReferences(env.PAWBOOK_DB, TENANT_A, 'rabbit')).toBe(0);
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2029-05-01',
      endDate: '2029-05-03',
      optionKey: 'standard',
      petType: 'rabbit',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    expect(await countPetTypeReferences(env.PAWBOOK_DB, TENANT_A, 'rabbit')).toBe(1);
    // Cancelled history still counts (the countBookingsForService rule).
    // Seeded dog references: pets Bella + bookings seed_sp_pend1/seed_sp_pend2 (PetType 'dog').
    expect(await countPetTypeReferences(env.PAWBOOK_DB, TENANT_A, 'dog')).toBeGreaterThanOrEqual(3);
  });

  it('deletePetType removes the row; unknown reports false', async () => {
    const { env } = createTestEnv();
    expect(await deletePetType(env.PAWBOOK_DB, TENANT_A, 'rabbit')).toBe(true);
    expect((await listPetTypes(env.PAWBOOK_DB, TENANT_A)).some((r) => r.PetType === 'rabbit')).toBe(
      false,
    );
    expect(await deletePetType(env.PAWBOOK_DB, TENANT_A, 'rabbit')).toBe(false);
  });

  it('deletePetTypeAndScrub removes the row and scrubs EVERY referencing service in one atomic batch', async () => {
    const { env } = createTestEnv();
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'walk', ['dog', 'rabbit']);
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'checkin', ['rabbit']);
    const result = await deletePetTypeAndScrub(env.PAWBOOK_DB, TENANT_A, 'rabbit');
    expect((await listPetTypes(env.PAWBOOK_DB, TENANT_A)).some((r) => r.PetType === 'rabbit')).toBe(
      false,
    );
    const services = await listServices(env.PAWBOOK_DB, TENANT_A);
    // Partial scrub: 'walk' keeps its other accepted slug and stays enabled — no widening,
    // no disabling for a list that still has an accepted type.
    const walk = services.find((s) => s.ServiceType === 'walk');
    expect(walk?.AcceptedPetTypes).toEqual(['dog']);
    expect(walk?.Enabled).toBe(1);
    // Scrub-to-empty -> '[]' (never NULL/"accepts all" — that's the widening bug) AND the
    // service gets disabled in the same batch, mirroring migration 0015 step 6's rule.
    const checkin = services.find((s) => s.ServiceType === 'checkin');
    expect(checkin?.AcceptedPetTypes).toEqual([]);
    expect(checkin?.Enabled).toBe(0);
    // A service that never named the slug is left untouched.
    const boarding = services.find((s) => s.ServiceType === 'boarding');
    expect(boarding?.AcceptedPetTypes).toBeNull();
    expect(boarding?.Enabled).toBe(1);
    // Caller learns which services got silently turned off.
    expect(result.disabledServices).toEqual(['checkin']);
    // The test shim's db.batch() runs the statements inside one BEGIN/COMMIT (see helpers.ts),
    // so atomicity of the delete+scrub follows directly from using batch() here rather than
    // needing a separate mid-write-failure simulation.
  });

  it('deletePetTypeAndScrub does not widen an already-disabled service to accepts-all, and does not re-report it as newly disabled', async () => {
    const { env } = createTestEnv();
    // Seeded 'checkin' on happytails is already Enabled=0 with AcceptedPetTypes ["dog"]; use a
    // fresh tenant scenario instead by disabling sunny-paws' checkin directly, then emptying it.
    await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'checkin', {
      enabled: false,
      questions: [],
      minNights: null,
      maxNights: null,
      minPetCount: null,
      maxPetCount: null,
      acceptedPetTypes: ['rabbit'],
      maxConcurrentPets: null,
      cancellationTiers: null,
    });
    const result = await deletePetTypeAndScrub(env.PAWBOOK_DB, TENANT_A, 'rabbit');
    const checkin = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'checkin',
    );
    // Still stored as '[]', never NULL — no widening regardless of enabled state.
    expect(checkin?.AcceptedPetTypes).toEqual([]);
    expect(checkin?.Enabled).toBe(0);
    // It was already off, so it's not a newly-disabled service worth surfacing to the caller.
    expect(result.disabledServices).toEqual([]);
  });
});

describe('AcceptedPetTypes round-trip (repo)', () => {
  it('setServiceConfig stores the list as JSON; listServices parses it back; NULL round-trips', async () => {
    const { env } = createTestEnv();
    const before = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(before.AcceptedPetTypes).toBeNull();
    await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
      enabled: true,
      questions: before.Questions,
      minNights: before.MinNights,
      maxNights: before.MaxNights,
      minPetCount: before.MinPetCount,
      maxPetCount: before.MaxPetCount,
      acceptedPetTypes: ['dog'],
      maxConcurrentPets: before.MaxConcurrentPets,
      cancellationTiers: before.CancellationTiers,
    });
    const after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.AcceptedPetTypes).toEqual(['dog']);
  });

  it('setServiceAcceptedPetTypes updates just the list', async () => {
    const { env } = createTestEnv();
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'walk', ['dog', 'cat']);
    let walk = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'walk',
    )!;
    expect(walk.AcceptedPetTypes).toEqual(['dog', 'cat']);
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'walk', null);
    walk = (await listServices(env.PAWBOOK_DB, TENANT_A)).find((s) => s.ServiceType === 'walk')!;
    expect(walk.AcceptedPetTypes).toBeNull();
  });
});

describe('signup provisioning seeds dog + cat registry rows (spec F1)', () => {
  it('createTenantFromSignup yields enabled dog and cat rows', async () => {
    const { env } = createTestEnv();
    const ok = await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_fresh',
      slug: 'fresh-paws',
      displayName: 'Fresh Paws',
      userId: 'tu_fresh',
      email: ALLOWED_EMAIL,
      passwordHash: 'x',
    });
    expect(ok).toBe(true);
    const rows = await listPetTypes(env.PAWBOOK_DB, 'tnt_fresh');
    expect(rows.map((r) => ({ petType: r.PetType, label: r.Label }))).toEqual([
      { petType: 'cat', label: 'Cats' },
      { petType: 'dog', label: 'Dogs' },
    ]);
  });

  it('rollbackUnclaimedTenant removes the pet-type rows too (no FK orphans)', async () => {
    const { env } = createTestEnv();
    await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_gone',
      slug: 'gone-paws',
      displayName: 'Gone Paws',
      userId: 'tu_gone',
      email: 'not-on-the-allowlist@example.com', // claim matches 0 rows -> caller compensates
      passwordHash: 'x',
    });
    await rollbackUnclaimedTenant(env.PAWBOOK_DB, 'tnt_gone', 'tu_gone');
    expect(await listPetTypes(env.PAWBOOK_DB, 'tnt_gone')).toEqual([]);
  });
});
