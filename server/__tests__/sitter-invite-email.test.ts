import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendResetLink, sendSignupLink, sendSitterInvite } from '../lib/email';

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
    expect(body.subject).toBe("You've been invited to set up your Pawservation account");
    expect(body.text).toContain('https://w.test/setup?t=abc.def');
    expect(body.html).toContain('https://w.test/setup?t=abc.def');
    expect(body.text).toContain('7 days');
    expect(body.html).toContain('7 days');
    // Fallback: the self-serve path at <origin>/admin, "New here".
    expect(body.text).toContain('https://w.test/admin');
    expect(body.html).toContain('https://w.test/admin');
    expect(body.text).toContain('New here');
    expect(body.html).toContain('New here');
    // Both text and html contain the how-it-works link.
    expect(body.text).toContain('https://pawservation.com/how-it-works');
    expect(body.html).toContain('https://pawservation.com/how-it-works');
    // HTML uses the emailShell, which gives it a 560px max-width column.
    expect(body.html).toContain('max-width:560px');
  });

  it('throws when email is not configured', async () => {
    await expect(
      sendSitterInvite({} as Env, 'a@b.c', 'https://w.test/setup?t=x'),
    ).rejects.toThrow();
  });
});

describe('sendSignupLink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a signup-complete link from the no-reply sender', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendSignupLink(env, 'sitter@example.com', 'https://w.test/setup?t=xyz');
    const init = spy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('sitter@example.com');
    expect(body.from).toBe(env.RESEND_FROM_NOREPLY);
    expect(body.text).toContain('https://w.test/setup?t=xyz');
    expect(body.html).toContain('https://w.test/setup?t=xyz');
    // Both text and html contain the how-it-works link.
    expect(body.text).toContain('https://pawservation.com/how-it-works');
    expect(body.html).toContain('https://pawservation.com/how-it-works');
    // HTML uses the emailShell.
    expect(body.html).toContain('max-width:560px');
  });

  it('throws when email is not configured', async () => {
    await expect(sendSignupLink({} as Env, 'a@b.c', 'https://w.test/setup?t=x')).rejects.toThrow();
  });
});

describe('sendResetLink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a password-reset link from the no-reply sender', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendResetLink(env, 'sitter@example.com', 'https://w.test/reset?t=abc');
    const init = spy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('sitter@example.com');
    expect(body.from).toBe(env.RESEND_FROM_NOREPLY);
    expect(body.text).toContain('https://w.test/reset?t=abc');
    expect(body.html).toContain('https://w.test/reset?t=abc');
    // Both text and html contain the how-it-works link.
    expect(body.text).toContain('https://pawservation.com/how-it-works');
    expect(body.html).toContain('https://pawservation.com/how-it-works');
    // HTML uses the emailShell.
    expect(body.html).toContain('max-width:560px');
  });

  it('throws when email is not configured', async () => {
    await expect(sendResetLink({} as Env, 'a@b.c', 'https://w.test/reset?t=x')).rejects.toThrow();
  });
});
