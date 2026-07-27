import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

function withResendEnv(env: unknown) {
  (env as Record<string, unknown>).RESEND_API_KEY = 'test-key';
  (env as Record<string, unknown>).RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
  (env as Record<string, unknown>).RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
}

describe('POST /admin/customers/:id/welcome', () => {
  // eu_sp_jess is seeded 'active' (sql/seed.sql), not 'invited' — this test also pins that the
  // welcome route is allowed for BOTH invited and active customers, not just fresh invites.
  it('sends the welcome email to an existing (active) customer', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const res = await app.request(
        `/api/${SLUG}/admin/customers/eu_sp_jess/welcome`,
        { method: 'POST', headers: await adminHeaders(TENANT_A) },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        to: string;
        from: string;
        html: string;
        subject: string;
      };
      expect(body.to).toBe('jess@example.com');
      expect(body.from).toBe('Pawservation <booking@example.com>');
      expect(body.html).toContain('/embed/sunny-paws');
      expect(body.subject).toContain('Sunny Paws');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('is re-sendable — calling it twice sends two fresh copies, never errors as "already sent"', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const headers = await adminHeaders(TENANT_A);
      const first = await app.request(
        `/api/${SLUG}/admin/customers/eu_sp_jess/welcome`,
        { method: 'POST', headers },
        env,
      );
      const second = await app.request(
        `/api/${SLUG}/admin/customers/eu_sp_jess/welcome`,
        { method: 'POST', headers },
        env,
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('404s on a cross-tenant id (a real TENANT_B customer via TENANT_A headers)', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const res = await app.request(
        `/api/${SLUG}/admin/customers/eu_ht_jess/welcome`,
        { method: 'POST', headers: await adminHeaders(TENANT_A) },
        env,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found.' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('404s on an unknown id', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu_nope/welcome`,
      { method: 'POST', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns a friendly 503 when email is not configured', async () => {
    const { env } = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await app.request(
        `/api/${SLUG}/admin/customers/eu_sp_jess/welcome`,
        { method: 'POST', headers: await adminHeaders(TENANT_A) },
        env,
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/email.*(isn't|not).*set up/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns 502 when the email provider fails', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    try {
      const res = await app.request(
        `/api/${SLUG}/admin/customers/eu_sp_jess/welcome`,
        { method: 'POST', headers: await adminHeaders(TENANT_A) },
        env,
      );
      expect(res.status).toBe(502);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('requires admin auth', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu_sp_jess/welcome`,
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(401);
  });
});
