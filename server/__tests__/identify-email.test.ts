import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
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
    env.RESEND_FROM = 'Pawbook <bookings@example.com>';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await identify(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codeId: string; prototypeCode?: string };
    expect(body.codeId).toBeTruthy();
    expect(body.prototypeCode).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
  });

  it('returns 502 when the email provider fails', async () => {
    const { env } = createTestEnv();
    env.RESEND_API_KEY = 'test-key';
    env.RESEND_FROM = 'Pawbook <bookings@example.com>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    const res = await identify(env);
    expect(res.status).toBe(502);
  });
});
