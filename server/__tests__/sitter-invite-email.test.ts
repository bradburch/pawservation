import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSitterInvite } from '../lib/email';

const env = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
} as unknown as Env;

describe('sendSitterInvite', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts an invite from the no-reply sender with the setup link and 7-day expiry', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendSitterInvite(env, 'sitter@example.com', 'https://w.test/setup?t=abc.def');
    const init = spy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('sitter@example.com');
    expect(body.from).toBe(env.RESEND_FROM_NOREPLY); // account-access mail, not booking
    expect(body.text).toContain('https://w.test/setup?t=abc.def');
    expect(body.html).toContain('https://w.test/setup?t=abc.def');
    expect(body.text).toContain('7 days');
    // Fallback: the self-serve path at <origin>/admin, "New here".
    expect(body.text).toContain('https://w.test/admin');
    expect(body.text).toContain('New here');
  });

  it('throws when email is not configured', async () => {
    await expect(
      sendSitterInvite({} as Env, 'a@b.c', 'https://w.test/setup?t=x'),
    ).rejects.toThrow();
  });
});
