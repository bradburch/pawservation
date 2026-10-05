import { describe, expect, it } from 'vitest';
import app from '../index';
import { ensureDemoCustomer } from '../db/repo';
import { DEMO_EMAIL, DEMO_PHONE } from '../lib/demo';
import { createTestEnv, demoToken, endUserToken, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

const countEndUsers = (raw: ReturnType<typeof createTestEnv>['raw']) =>
  (raw.prepare('SELECT COUNT(*) AS n FROM EndUsers').get() as { n: number }).n;

/**
 * Every path that creates a client requires a phone. The widget's sign-in is not one of them, and
 * this pins that it stays that way: /identify is invite-only and /verify only promotes, so a new
 * creation path added there would have to get past these tests first.
 */
describe('the sign-in path creates no client', () => {
  it('identify refuses an unknown email and writes no row', async () => {
    const { env, raw } = createTestEnv();
    const before = countEndUsers(raw);
    const res = await app.request(
      `/api/${SLUG}/identify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'stranger@example.com' }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(countEndUsers(raw)).toBe(before);
  });

  it('an unknown email cannot get through the verify step either, and no row appears', async () => {
    const { env, raw } = createTestEnv();
    const before = countEndUsers(raw);
    const post = (path: string, body: unknown) =>
      app.request(
        `/api/${SLUG}/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      );
    // identify mints no code for a stranger, so there is nothing to verify; a made-up code id and
    // code (the only thing a caller could send) must be refused rather than create the person.
    const idRes = await post('identify', { email: 'stranger@example.com' });
    expect(idRes.status).toBe(403);
    const vRes = await post('verify', { codeId: 'lc_stranger', code: '123456' });
    expect(vRes.status).toBe(401);
    expect(((await vRes.json()) as { token?: string }).token).toBeUndefined();
    expect(countEndUsers(raw)).toBe(before);
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('stranger@example.com'),
    ).toBeUndefined();
  });

  it('a full identify → verify round trip for a known client inserts nothing', async () => {
    const { env, raw } = createTestEnv();
    const before = countEndUsers(raw);
    await endUserToken(env, SLUG, 'jess@example.com');
    expect(countEndUsers(raw)).toBe(before);
  });
});

/**
 * The demo login's shadow customer is provisioned on sign-in. It is not a client (it is excluded
 * from every client list), but it signs in to the same widget, so without a phone it would meet
 * the one-time phone prompt on the public demo page.
 */
describe('the demo shadow customer has a phone', () => {
  it('is provisioned with the fixed demo phone', async () => {
    const { env } = createTestEnv();
    const shadow = await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    expect(shadow.Phone).toBe(DEMO_PHONE);
  });

  it('backfills a shadow provisioned before the change, and no other row', async () => {
    const { env, raw } = createTestEnv();
    const shadow = await ensureDemoCustomer(env.PAWSERVATION_DB, TENANT_A, DEMO_EMAIL, 'dog');
    raw.prepare(`UPDATE EndUsers SET Phone = '  ' WHERE Id = ?`).run(shadow.Id);
    raw.prepare(`UPDATE EndUsers SET Phone = NULL WHERE Email = 'jess@example.com'`).run();

    await demoToken(env, SLUG); // the real sign-in path re-runs ensureDemoCustomer

    const phoneOf = (id: string) =>
      (raw.prepare('SELECT Phone FROM EndUsers WHERE Id = ?').get(id) as { Phone: string | null })
        .Phone;
    expect(phoneOf(shadow.Id)).toBe(DEMO_PHONE);
    expect(phoneOf('eu_sp_jess')).toBeNull(); // a real client is never touched by this
  });
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const getMe = async (env: Env, token: string) =>
  (await (await app.request(`/api/${SLUG}/me`, { headers: auth(token) }, env)).json()) as {
    name: string | null;
    phone: string | null;
  };
const patchMe = (env: Env, token: string, body: unknown) =>
  app.request(
    `/api/${SLUG}/me`,
    {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
const book = (env: Env, token: string) =>
  app.request(
    `/api/${SLUG}/bookings`,
    {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        startDate: '2028-11-06',
        endDate: '2028-11-08',
        petIds: ['pet_sp_bella'],
        answers: {},
      }),
    },
    env,
  );
const setJessPhone = (raw: ReturnType<typeof createTestEnv>['raw'], phone: string | null) =>
  raw.prepare(`UPDATE EndUsers SET Phone = ? WHERE Id = 'eu_sp_jess'`).run(phone);

describe('GET /:slug/me: phone', () => {
  it('reports the phone on file, trimmed', async () => {
    const { env, raw } = createTestEnv();
    setJessPhone(raw, '  (555) 555-0142 ');
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    expect((await getMe(env, token)).phone).toBe('(555) 555-0142');
  });

  it('reports null — never an empty string — when the phone is missing or only whitespace', async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    for (const stored of [null, '', '   ']) {
      setJessPhone(raw, stored);
      expect((await getMe(env, token)).phone).toBeNull();
    }
  });

  it('keeps every field it already had', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    expect(Object.keys(await getMe(env, token)).sort()).toEqual(
      ['name', 'pets', 'phone', 'savedAnswers'].sort(),
    );
  });
});

describe('PATCH /:slug/me', () => {
  it('sets the caller’s own phone, trimmed, and /me reports it', async () => {
    const { env, raw } = createTestEnv();
    setJessPhone(raw, null);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await patchMe(env, token, { phone: '  555 0100 (mum) ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ phone: '555 0100 (mum)' });
    expect((await getMe(env, token)).phone).toBe('555 0100 (mum)');
  });

  it('refuses a missing, blank or malformed phone with the shared codes, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    setJessPhone(raw, null);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    for (const [body, code] of [
      [{}, 'phone_required'],
      [{ phone: '   ' }, 'phone_required'],
      [{ phone: 'n/a' }, 'phone_invalid'],
      [{ phone: 5555550100 }, 'phone_invalid'],
    ] as const) {
      const res = await patchMe(env, token, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(code);
    }
    expect((await getMe(env, token)).phone).toBeNull();
  });

  it('changes only the caller’s own row — never a same-email client of another sitter', async () => {
    const { env, raw } = createTestEnv();
    // jess@example.com is a client of sunny-paws AND happy-tails: two rows, two people.
    raw.prepare(`UPDATE EndUsers SET Phone = NULL WHERE Email = 'jess@example.com'`).run();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    expect((await patchMe(env, token, { phone: '(555) 555-0199' })).status).toBe(200);
    const phones = raw
      .prepare(`SELECT Id, Phone FROM EndUsers WHERE Email = 'jess@example.com' ORDER BY Id`)
      .all() as { Id: string; Phone: string | null }[];
    expect(phones).toEqual([
      { Id: 'eu_ht_jess', Phone: null },
      { Id: 'eu_pr_jess', Phone: null },
      { Id: 'eu_sp_jess', Phone: '(555) 555-0199' },
    ]);
  });

  it('requires a signed-in client', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      `/api/${SLUG}/me`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '(555) 555-0100' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('refuses the demo identity — its row is shared by every demo visitor', async () => {
    const { env, raw } = createTestEnv();
    const token = await demoToken(env, SLUG);
    const res = await patchMe(env, token, { phone: '(555) 555-0199' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('demo_identity');
    const shadow = raw
      .prepare(`SELECT Phone FROM EndUsers WHERE TenantId = ? AND Email = ?`)
      .get(TENANT_A, DEMO_EMAIL) as { Phone: string };
    expect(shadow.Phone).toBe(DEMO_PHONE);
  });
});

/**
 * The owner's ruling: a signed-in client with no phone on file cannot book until they give one.
 * Enforced in the booking operation, not only in the widget, so no client of the API can skip it.
 */
describe('POST /:slug/bookings: a phone on file is required', () => {
  it('refuses a client with no phone, or a whitespace-only one, and writes no booking', async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const before = (raw.prepare('SELECT COUNT(*) AS n FROM BookingRequests').get() as { n: number })
      .n;
    for (const stored of [null, '  ']) {
      setJessPhone(raw, stored);
      const res = await book(env, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Add a phone number so Sunny Paws can reach you, then send your request again.',
        code: 'phone_required',
      });
    }
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM BookingRequests').get() as { n: number }).n,
    ).toBe(before);
  });

  it('books once the client has added a phone', async () => {
    const { env, raw } = createTestEnv();
    setJessPhone(raw, null);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    expect((await book(env, token)).status).toBe(400);
    expect((await patchMe(env, token, { phone: '(555) 555-0142' })).status).toBe(200);
    expect((await book(env, token)).status).toBe(201);
  });

  it('reports a problem with the REQUEST before the missing phone', async () => {
    const { env, raw } = createTestEnv();
    setJessPhone(raw, null);
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/bookings`,
      {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'boarding', petIds: ['pet_sp_bella'], answers: {} }),
      },
      env,
    );
    expect(((await res.json()) as { code: string }).code).not.toBe('phone_required');
  });

  it('never blocks the demo identity, which persists nothing', async () => {
    const { env } = createTestEnv();
    const token = await demoToken(env, SLUG);
    const me = (await (
      await app.request(`/api/${SLUG}/me`, { headers: auth(token) }, env)
    ).json()) as { pets: { id: string }[]; phone: string | null };
    expect(me.phone).toBe(DEMO_PHONE);
    const res = await app.request(
      `/api/${SLUG}/bookings`,
      {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-11-06',
          endDate: '2028-11-08',
          petIds: [me.pets[0]!.id],
          answers: {},
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
  });
});
