import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { createLoginCode } from '../db/repo';
import { createTestEnv } from './helpers';

/** When email is configured, /identify must email the code and never return it in the response. */
describe('identify with email configured', () => {
  afterEach(() => vi.restoreAllMocks());

  function identify(env: Env) {
    return app.request(
      '/api/sunny-paws/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jess@example.com' }),
      },
      env,
    );
  }

  it('sends via Resend and omits prototypeCode from the response', async () => {
    const { env } = createTestEnv();
    env.RESEND_API_KEY = 'test-key';
    env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
    env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await identify(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codeId: string; prototypeCode?: string };
    expect(body.codeId).toBeTruthy();
    expect(body.prototypeCode).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(sentBody.from).toBe(env.RESEND_FROM_NOREPLY); // login mail, not the booking sender
  });

  it('returns 502 when the email provider fails', async () => {
    const { env } = createTestEnv();
    env.RESEND_API_KEY = 'test-key';
    env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
    env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    const res = await identify(env);
    expect(res.status).toBe(502);
  });

  it('fails closed (503) in production when no email provider is configured', async () => {
    const { env } = createTestEnv();
    env.ENVIRONMENT = 'production'; // not development, and no RESEND_* set
    // paws-and-relax isn't one of the public /demo tenants, so it still needs a real provider.
    const res = await app.request(
      '/api/paws-and-relax/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jess@example.com' }),
      },
      env,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { prototypeCode?: string };
    expect(body.prototypeCode).toBeUndefined();
  });

  it('still shows the on-screen code in production for the public demo tenant', async () => {
    const { env } = createTestEnv();
    env.ENVIRONMENT = 'production'; // no RESEND_* set — /demo visitors have no real inbox
    const res = await identify(env); // sunny-paws
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prototypeCode?: string };
    expect(body.prototypeCode).toBeTruthy();
  });
});

/** Verify that creating a new login code deletes expired codes but leaves valid ones intact. */
describe('login code pruning on creation', () => {
  it('deletes expired codes for the same tenant and keeps unexpired ones', async () => {
    const { env, raw } = createTestEnv();
    const tenantId = 'tnt_sunnypaws';
    const endUserId = 'eu_sp_jess'; // seeded test user

    // Set up: insert an already-expired code and an unexpired code for the same tenant.
    const expiredCodeId = crypto.randomUUID();
    const unexpiredCodeId = crypto.randomUUID();
    const now = new Date();
    const expiredTime = new Date(now.getTime() - 1000).toISOString(); // 1 second in the past
    const unexpiredTime = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // 1 hour in future

    raw.exec(`
      INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
      VALUES ('${expiredCodeId}', '${tenantId}', '${endUserId}', 'expired123', '${expiredTime}')
    `);
    raw.exec(`
      INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
      VALUES ('${unexpiredCodeId}', '${tenantId}', '${endUserId}', 'valid456', '${unexpiredTime}')
    `);

    // Create a new login code with a specific "now" that should prune the expired one.
    const nowForPrune = new Date(now.getTime() + 500); // halfway between expired and unexpired
    const newCodeId = await createLoginCode(
      env.PAWBOOK_DB,
      tenantId,
      endUserId,
      'newcode789',
      new Date(nowForPrune.getTime() + 10 * 60 * 1000).toISOString(), // 10 min from "now"
      nowForPrune.toISOString(),
    );

    // Verify: expired code is gone, unexpired code and new code remain.
    const expiredRow = raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get(expiredCodeId);
    const unexpiredRow = raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get(unexpiredCodeId);
    const newRow = raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get(newCodeId);

    expect(expiredRow).toBeUndefined();
    expect(unexpiredRow).toBeDefined();
    expect(newRow).toBeDefined();
  });
});
