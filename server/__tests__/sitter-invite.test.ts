import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { INVITE_LINK_TTL_SECONDS, verifySignupLink } from '../lib/signup-link';
import { mintOwnerToken } from '../lib/token';
import { ALLOWED_EMAIL, createTestEnv, OWNER_EMAIL, TEST_SECRET } from './helpers';

function configureEmail(env: Env) {
  env.RESEND_API_KEY = 'test-key';
  env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
  env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
}

const ownerHeaders = async () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${await mintOwnerToken(OWNER_EMAIL, TEST_SECRET)}`,
});

const post = async (env: Env, email: string) =>
  app.request(
    '/api/owner/allowlist',
    { method: 'POST', headers: await ownerHeaders(), body: JSON.stringify({ email }) },
    env,
  );

// Pull the /setup token out of the invite email's text field.
function tokenFromSend(spy: ReturnType<typeof vi.spyOn>, callIndex = 0): string {
  const body = JSON.parse((spy.mock.calls[callIndex][1] as RequestInit).body as string);
  const url = (body.text as string).match(/https?:\/\/\S*\/setup\?t=[^\s]+/)![0];
  return new URL(url).searchParams.get('t')!;
}

describe('POST /api/owner/allowlist — invite email', () => {
  afterEach(() => vi.restoreAllMocks());

  it('new unclaimed email → 200, emailSent true, 7-day sitter link sent', async () => {
    const { env } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const before = Date.now();
    const res = await post(env, 'brand-new@x.test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entry: { email: string }; emailSent: boolean };
    expect(body.entry.email).toBe('brand-new@x.test');
    expect(body.emailSent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const token = tokenFromSend(fetchSpy);
    const payload = await verifySignupLink(TEST_SECRET, token, Date.now());
    expect(payload!.kind).toBe('sitter');
    expect(payload!.email).toBe('brand-new@x.test');
    expect(payload!.exp).toBeGreaterThanOrEqual(before + INVITE_LINK_TTL_SECONDS * 1000);
  });

  it('re-add of an unclaimed email resends with a fresh nonce, one row only', async () => {
    const { env, raw } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await post(env, ALLOWED_EMAIL);
    await post(env, ALLOWED_EMAIL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Fresh nonce each time.
    const p1 = await verifySignupLink(TEST_SECRET, tokenFromSend(fetchSpy, 0), Date.now());
    const p2 = await verifySignupLink(TEST_SECRET, tokenFromSend(fetchSpy, 1), Date.now());
    expect(p1!.nonce).not.toBe(p2!.nonce);
    // Still exactly one allowlist row for that email.
    const n = (
      raw
        .prepare('SELECT COUNT(*) AS n FROM AllowedSitters WHERE Email = ?')
        .get(ALLOWED_EMAIL) as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('re-add of a CLAIMED email sends nothing (emailSent false), row unchanged', async () => {
    const { env, raw } = createTestEnv();
    configureEmail(env);
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt, TenantId) VALUES ('done@x.test', '2026-01-01T00:00:00Z', 'tnt_sunnypaws')",
      )
      .run();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await post(env, 'done@x.test');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { emailSent: boolean }).emailSent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = raw
      .prepare('SELECT ClaimedAt, TenantId FROM AllowedSitters WHERE Email = ?')
      .get('done@x.test') as { ClaimedAt: string; TenantId: string };
    expect(row.ClaimedAt).toBe('2026-01-01T00:00:00Z');
    expect(row.TenantId).toBe('tnt_sunnypaws');
  });

  it('a send failure → 200, emailSent false, row still added, error logged', async () => {
    const { env, raw } = createTestEnv();
    configureEmail(env);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await post(env, 'flaky@x.test');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { emailSent: boolean }).emailSent).toBe(false);
    expect(errSpy).toHaveBeenCalledWith('sitter invite send failed', expect.anything());
    const n = (
      raw
        .prepare('SELECT COUNT(*) AS n FROM AllowedSitters WHERE Email = ?')
        .get('flaky@x.test') as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('owner-email add is still rejected 400 with no send', async () => {
    const { env } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await post(env, OWNER_EMAIL);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dev + no email provider: returns prototypeLink, attempts no send', async () => {
    const { env } = createTestEnv(); // ENVIRONMENT=development, no RESEND_*
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await post(env, 'demo@x.test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailSent: boolean; prototypeLink?: string };
    expect(body.emailSent).toBe(false);
    expect(body.prototypeLink).toMatch(/\/setup\?t=/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('end-to-end: an invite-minted link completes signup via /signup/complete', async () => {
    const { env, raw } = createTestEnv(); // dev degrade → prototypeLink handed back
    const added = (await (await post(env, 'e2e-sitter@x.test')).json()) as {
      prototypeLink: string;
    };
    const token = new URL(added.prototypeLink).searchParams.get('t')!;
    const res = await app.request(
      '/api/signup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'hunter22', businessName: 'E2E Walks' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('admin');
    // Allowlist row now claimed, tenant created.
    const claim = raw
      .prepare('SELECT ClaimedAt, TenantId FROM AllowedSitters WHERE Email = ?')
      .get('e2e-sitter@x.test') as { ClaimedAt: string | null; TenantId: string | null };
    expect(claim.ClaimedAt).toBeTruthy();
    expect(raw.prepare('SELECT 1 FROM Tenants WHERE Id = ?').get(claim.TenantId)).toBeTruthy();
  });

  it('unconfigured email outside development adds the row without minting', async () => {
    const { env, raw } = createTestEnv();
    // Blank email config (simulate unconfigured email).
    env.RESEND_API_KEY = undefined;
    env.RESEND_FROM_NOREPLY = undefined;
    env.RESEND_FROM_BOOKING = undefined;
    env.ENVIRONMENT = 'production';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await post(env, 'unconfigured@x.test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailSent: boolean; prototypeLink?: string };
    expect(body.emailSent).toBe(false);
    expect(body.prototypeLink).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Row should exist.
    const n = (
      raw
        .prepare('SELECT COUNT(*) AS n FROM AllowedSitters WHERE Email = ?')
        .get('unconfigured@x.test') as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});
