import { describe, expect, it, vi, afterEach } from 'vitest';
import app from '../index';
import { sendSitterInvite } from '../lib/email';
import { insertInvitedCustomer } from '../db/repo';
import { mintToken } from '../lib/token';
import { createTestEnv, TENANT_B, TEST_SECRET } from './helpers';

const env = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
} as unknown as Env;

/**
 * Every one of these throws is logged verbatim by a caller (`routes/signup.ts`,
 * `routes/password-reset.ts`, `routes/owner.ts`, `routes/invite-request.ts`). Whatever ends up in
 * the message ends up in the Workers log, so the message is a log-hygiene surface, not just an
 * error string. Same rule `lib/google-calendar.ts`'s `describeTokenError` already applies to
 * Google: lift the machine-readable code, never the free-text body.
 */
describe('Resend failures are described without echoing the upstream body', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not put the recipient address from a Resend error into the thrown message', async () => {
    // Resend's real sandbox refusal — it quotes an email address back at you.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 403,
          name: 'validation_error',
          message: 'You can only send testing emails to your own email address (owner@example.com)',
        }),
        { status: 403 },
      ),
    );
    const err = await sendSitterInvite(env, 'sitter@example.com', 'https://w.test/setup?t=a').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain('owner@example.com');
    expect(err!.message).not.toContain('@');
    // Still diagnosable: the status and Resend's own machine-readable name survive.
    expect(err!.message).toContain('403');
    expect(err!.message).toContain('validation_error');
  });

  it('reports an unparseable Resend body as such rather than pasting it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>gateway timeout for sitter@example.com</html>', { status: 502 }),
    );
    const err = await sendSitterInvite(env, 'sitter@example.com', 'https://w.test/setup?t=a').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err!.message).not.toContain('sitter@example.com');
    expect(err!.message).toContain('502');
  });
});

/**
 * Credential refusals are the one class of event where "nothing in the log" is itself the defect.
 * A widget token replayed against another sitter is exactly what a cross-tenant probe looks like,
 * and today it 403s in total silence. These go to `console.warn` rather than `console.error` so an
 * alert can separate "someone is trying things" from "our calendar sync broke".
 */
describe('credential refusals are reported, without reporting the credential', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns when a widget token from another tenant is presented, and never logs the token', async () => {
    const { env } = createTestEnv();
    // A perfectly valid token — for the WRONG sitter.
    const foreign = await mintToken('eu_someone', TENANT_B, TEST_SECRET);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${foreign}` } },
      env,
    );

    expect(res.status).toBe(403);
    const line = warn.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(line).toContain('wrong_tenant');
    // The whole point: diagnosable without being a credential dump.
    expect(line).not.toContain(foreign);
  });

  it('warns when a personal access token is rejected, and never logs the token', async () => {
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: 'Bearer pawsv_deadbeefdeadbeefdeadbeefdeadbeef' } },
      env,
    );

    expect(res.status).toBe(401);
    const line = warn.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(line).toContain('personal_access_token_rejected');
    expect(line).not.toContain('deadbeef');
  });
});

/**
 * A cap that never reports is a cap you cannot tell from an absence of traffic. These are also the
 * three routes where the rate-limit KEY is built out of the caller's email and IP, so the trip has
 * to be reported without it.
 */
describe('rate-limit trips are reported, without reporting the key', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns when a password-reset request goes over its cap, naming neither email nor IP', async () => {
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = () =>
      app.request(
        '/api/password-reset/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
          body: JSON.stringify({ email: 'jess@example.com' }),
        },
        env,
      );
    // The cap is 5 per window; the 6th is the one that trips.
    for (let i = 0; i < 6; i++) await send();

    const line = warn.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(line).toContain('rate_limited');
    expect(line).not.toContain('jess@example.com');
    expect(line).not.toContain('203.0.113.9');
  });
});

/**
 * Mail is the whole of account access — login codes, reset links, signup links. A Resend outage
 * takes sign-in down for every customer of every sitter, and `routes/auth.ts` answered that with a
 * bare 502 and an empty log.
 */
describe('account-access mail failures are not silent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs when a login code cannot be sent', async () => {
    const { env } = createTestEnv();
    Object.assign(env, {
      RESEND_API_KEY: 'k',
      RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
      RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429 }),
    );
    // NOT sunny-paws/happy-tails: those are `DEMO_TENANT_SLUGS`, which hand the code straight
    // back on screen and never touch the mail path this test is about.
    await insertInvitedCustomer(env.PAWSERVATION_DB, 'tnt_pawsandrelax', 'jess@example.com', null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(
      '/api/paws-and-relax/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jess@example.com' }),
      },
      env,
    );

    expect(res.status).toBe(502);
    const line = error.mock.calls
      .flat()
      .map((a) => (a instanceof Error ? a.message : String(a)))
      .join('\n');
    expect(line).toContain('login code send failed');
    // The upstream reason survives (that is the point); the customer does not.
    expect(line).toContain('rate_limit_exceeded');
    expect(line).not.toContain('jess@example.com');
  });
});

/**
 * `console.error('unhandled error', err)` says WHAT broke and nothing about WHERE. Cloudflare's
 * observability groups a request's logs by invocation, but the one thing it cannot give you is the
 * join to another worker's invocation — premium calls this API on every request — and that join is
 * the `cf-ray`.
 */
describe('unhandled errors carry enough request context to find them again', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the method, the path and the ray — and not the query string', async () => {
    const { env } = createTestEnv();
    vi.spyOn(env.PAWSERVATION_DB, 'prepare').mockImplementation(() => {
      throw new Error('boom');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(
      '/api/sunny-paws/config?email=jess@example.com',
      { headers: { 'CF-Ray': '8f1b2c3d4e5f6a7b-IAD' } },
      env,
    );

    expect(res.status).toBe(500);
    const line = error.mock.calls
      .flat()
      .map((a) => (a instanceof Error ? a.message : JSON.stringify(a)))
      .join('\n');
    expect(line).toContain('8f1b2c3d4e5f6a7b-IAD');
    expect(line).toContain('/api/sunny-paws/config');
    expect(line).toContain('GET');
    // A query string is caller-supplied and routinely carries an email. The path is not.
    expect(line).not.toContain('jess@example.com');
  });
});

/**
 * The half of a security log that is easy to get wrong: how MUCH of it there is, and whether it
 * can be joined to anything.
 */
describe('security events are bounded in volume and joinable to the other worker', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * The limiter exists to make abusive traffic cheap. A line per over-cap request makes it less
   * cheap — and hands an unauthenticated caller a dial on how much log they can generate, which is
   * how the interesting line gets buried. One line per bucket per window says everything the
   * sustained version says: this cap tripped, now.
   */
  it('logs a tripped cap once per window, not once per over-cap request', async () => {
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = () =>
      app.request(
        '/api/password-reset/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
          body: JSON.stringify({ email: 'jess@example.com' }),
        },
        env,
      );
    // Five fill the window; the sixth trips it; the next four keep hammering it.
    for (let i = 0; i < 10; i++) await send();

    const trips = warn.mock.calls.filter((c) => JSON.stringify(c).includes('rate_limited'));
    expect(trips).toHaveLength(1);
  });

  /**
   * `requestContext` is already the answer to "which request was this" — reusing it here means a
   * credential refusal carries the `cf-ray` too, which is the only id this worker and premium can
   * both see. Without it these events are the one class of log line that cannot be correlated.
   */
  it('carries the ray and the method on a credential refusal', async () => {
    const { env } = createTestEnv();
    const foreign = await mintToken('eu_someone', TENANT_B, TEST_SECRET);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${foreign}`, 'CF-Ray': '7a6b5c4d3e2f1a0b-IAD' } },
      env,
    );

    const line = warn.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(line).toContain('7a6b5c4d3e2f1a0b-IAD');
    expect(line).toContain('GET');
  });
});
