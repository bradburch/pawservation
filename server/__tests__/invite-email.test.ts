import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendInvite } from '../lib/email';

const env = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
} as unknown as Env;

describe('sendInvite', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts an invite email via Resend including the widget link', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendInvite(env, 'guest@example.com', 'Sunny Paws', 'https://w/embed/sunny-paws');
    const init = spy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('guest@example.com');
    expect(body.from).toBe(env.RESEND_FROM_BOOKING); // booking mail, not the no-reply sender
    expect(body.subject).toBe("You're set up to book with Sunny Paws");
    expect(body.text).toContain('https://w/embed/sunny-paws');
    expect(body.html).toContain('https://w/embed/sunny-paws');
    // Footer and shell.
    expect(body.html).toContain('on behalf of Sunny Paws');
    expect(body.html).toContain('max-width:560px');
  });

  it('throws when email is not configured', async () => {
    await expect(sendInvite({} as Env, 'a@b.c', 'X', 'https://w')).rejects.toThrow();
  });

  it('HTML-escapes the display name so it cannot inject markup into the email', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendInvite(env, 'guest@example.com', '<img src=x onerror=alert(1)>', 'https://w/embed/x');
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).not.toContain('<img');
    expect(body.html).toContain('&lt;img');
  });
});
