import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSeriesStatusEmail } from '../lib/email';

const env = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
} as unknown as Env;

const PATTERN = 'every Tuesday and Thursday from 13 Oct, no end date';

describe('sendSeriesStatusEmail', () => {
  afterEach(() => vi.restoreAllMocks());

  async function sent(statusWord: 'confirmed' | 'declined', displayName = 'Sunny Paws') {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendSeriesStatusEmail(env, 'client@example.com', displayName, statusWord, PATTERN);
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      string
    >;
  }

  it('posts one booking-sender email naming the status and the pattern words', async () => {
    const body = await sent('confirmed');
    expect(body.to).toBe('client@example.com');
    expect(body.from).toBe(env.RESEND_FROM_BOOKING);
    expect(body.subject).toBe('Your repeating booking with Sunny Paws was confirmed');
    for (const part of [PATTERN, 'confirmed', 'each walk is priced for its own date']) {
      expect(body.text).toContain(part);
      expect(body.html).toContain(part);
    }
    expect(body.html).toContain('on behalf of Sunny Paws');
  });

  it('says declined when declined', async () => {
    const body = await sent('declined');
    expect(body.subject).toBe('Your repeating booking with Sunny Paws was declined');
    expect(body.text).toContain('declined');
  });

  it('carries no figure', async () => {
    const body = await sent('confirmed');
    expect(body.text).not.toMatch(/\$|\d+\.\d\d/);
    expect(body.html).not.toContain('$');
  });

  it('HTML-escapes the display name and the pattern', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendSeriesStatusEmail(
      env,
      'client@example.com',
      '<img src=x onerror=alert(1)>',
      'confirmed',
      'every <b>Tuesday</b>',
    );
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).not.toContain('<img src=x');
    expect(body.html).not.toContain('<b>Tuesday');
    expect(body.html).toContain('&lt;img');
    expect(body.html).toContain('&lt;b&gt;Tuesday');
  });

  it('throws when email is not configured', async () => {
    await expect(
      sendSeriesStatusEmail({} as Env, 'a@b.c', 'X', 'declined', PATTERN),
    ).rejects.toThrow();
  });
});
