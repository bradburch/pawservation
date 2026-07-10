import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBookingStatusEmail } from '../lib/email';

const env = { RESEND_API_KEY: 'k', RESEND_FROM: 'Pawbook <b@x.com>' } as unknown as Env;

describe('sendBookingStatusEmail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts a status email via Resend with the status word and date range', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendBookingStatusEmail(
      env,
      'client@example.com',
      'Sunny Paws',
      'confirmed',
      '2030-03-01 – 2030-03-04',
    );
    const init = spy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('client@example.com');
    expect(body.subject).toBe('Your booking with Sunny Paws was confirmed');
    expect(body.html).toContain('2030-03-01 – 2030-03-04');
  });

  it('throws when email is not configured', async () => {
    await expect(
      sendBookingStatusEmail({} as Env, 'a@b.c', 'X', 'cancelled', '2030-01-01'),
    ).rejects.toThrow();
  });

  it('HTML-escapes the display name', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendBookingStatusEmail(
      env,
      'client@example.com',
      '<img src=x onerror=alert(1)>',
      'declined',
      '2030-01-01',
    );
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).not.toContain('<img');
    expect(body.html).toContain('&lt;img');
  });
});
