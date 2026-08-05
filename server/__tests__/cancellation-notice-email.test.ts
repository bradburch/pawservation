import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { sendCancellationNoticeToSitter, type CancellationNotice } from '../lib/email';
import { insertBookingRequest } from '../db/repo';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { createTestEnv, endUserToken, TENANT_A } from './helpers';
import type { DatabaseSync } from 'node:sqlite';

const env = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
} as unknown as Env;

const notice = (over: Partial<CancellationNotice> = {}): CancellationNotice => ({
  displayName: 'Sunny Paws',
  customerName: 'Jess Demo',
  customerEmail: 'jess@example.com',
  serviceLabel: 'Boarding',
  whenText: '2030-03-01 – 2030-03-04',
  wasConfirmed: true,
  cancellationFee: 100,
  ...over,
});

const sentBody = (spy: { mock: { calls: unknown[][] } }) =>
  JSON.parse(((spy.mock.calls[0][1] as RequestInit).body as string) ?? '{}') as {
    to: string;
    from: string;
    subject: string;
    text: string;
    html: string;
  };

describe('sendCancellationNoticeToSitter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts to the sitter from the BOOKING sender, with who/what/when and the stored fee', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendCancellationNoticeToSitter(env, 'sitter@sunnypaws.example', notice());
    const body = sentBody(spy);

    expect(body.to).toBe('sitter@sunnypaws.example');
    // Booking mail, not the account-access sender — the two-sender split holds.
    expect(body.from).toBe(env.RESEND_FROM_BOOKING);
    expect(body.from).not.toBe(env.RESEND_FROM_NOREPLY);
    expect(body.subject).toBe('Cancelled: Boarding for Jess Demo (2030-03-01 – 2030-03-04)');

    // Everything the sitter needs without opening the dashboard.
    for (const part of ['Jess Demo', 'Boarding', '2030-03-01 – 2030-03-04', 'jess@example.com']) {
      expect(body.html).toContain(part);
      expect(body.text).toContain(part);
    }
    expect(body.html).toContain('cancelled a confirmed booking');
    expect(body.html).toContain('Cancellation fee: $100');
    expect(body.html).toContain('on behalf of Sunny Paws');
  });

  it('reads differently for a withdrawn request, and never mentions a fee', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendCancellationNoticeToSitter(
      env,
      'sitter@x.test',
      notice({ wasConfirmed: false, cancellationFee: 0 }),
    );
    const body = sentBody(spy);
    expect(body.subject).toBe(
      'Withdrawn: Boarding request from Jess Demo (2030-03-01 – 2030-03-04)',
    );
    expect(body.html).toContain("withdrew a request you hadn't confirmed yet");
    expect(body.html).toContain('No cancellation fee applies');
    expect(body.html).not.toContain('cancelled a confirmed booking');
    // A sitter must never read "$0 owed" as if a fee had been assessed.
    expect(body.html).not.toContain('Cancellation fee: $');
  });

  it('says so plainly when a confirmed cancel falls outside every tier', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendCancellationNoticeToSitter(env, 'sitter@x.test', notice({ cancellationFee: 0 }));
    const body = sentBody(spy);
    expect(body.html).toContain('cancelled a confirmed booking');
    expect(body.html).toContain('No cancellation fee applies under your policy');
    expect(body.html).not.toContain('Cancellation fee: $');
  });

  it('falls back to the email address, then to "A client", when there is no name', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendCancellationNoticeToSitter(
      env,
      'sitter@x.test',
      notice({ customerName: '   ' }), // whitespace is not a name
    );
    expect(sentBody(spy).subject).toContain('jess@example.com');

    vi.restoreAllMocks();
    const spy2 = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendCancellationNoticeToSitter(
      env,
      'sitter@x.test',
      notice({ customerName: null, customerEmail: null }),
    );
    const body2 = sentBody(spy2);
    expect(body2.subject).toContain('A client');
    expect(body2.html).not.toContain('Client:'); // no empty contact row
  });

  it('throws when email is not configured', async () => {
    await expect(sendCancellationNoticeToSitter({} as Env, 'a@b.c', notice())).rejects.toThrow();
  });

  it('HTML-escapes every interpolated value', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await sendCancellationNoticeToSitter(
      env,
      'sitter@x.test',
      notice({
        customerName: '<img src=x onerror=alert(1)>',
        customerEmail: '"><script>alert(2)</script>',
        serviceLabel: '<b>Boarding</b>',
        displayName: 'Sunny <Evil> & Co',
        whenText: '<i>whenever</i>',
      }),
    );
    const body = sentBody(spy);
    expect(body.html).not.toContain('<img src=x');
    expect(body.html).not.toContain('<script>');
    expect(body.html).not.toContain('<b>Boarding</b>');
    expect(body.html).not.toContain('<i>whenever</i>');
    expect(body.html).toContain('&lt;img');
    expect(body.html).toContain('&lt;script&gt;');
    expect(body.html).toContain('&lt;Evil&gt;');
    // The shell's own brand logo is the ONLY <img> that survives into the body.
    expect((body.html.match(/<img/g) ?? []).length).toBe(1);
  });
});

// ── The route side: it fires, it carries the right shape, and it can never break a cancel. ──

const SLUG = 'sunny-paws';
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

function configuredEnv(base: Env): Env {
  return Object.assign(base, {
    RESEND_API_KEY: 'k',
    RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
    RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
  });
}

function seedBoardingTiers(raw: DatabaseSync): void {
  raw.exec(
    `UPDATE TenantServices SET CancellationTiers =
       '[{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]'
     WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding'`,
  );
}

async function seedBooking(
  env: Env,
  over: { status?: 'pending' | 'confirmed'; startsInDays?: number } = {},
): Promise<string> {
  const start = addDays(TODAY, over.startsInDays ?? 5);
  return insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: 'eu_sp_jess',
    serviceType: 'boarding',
    startDate: start,
    endDate: addDays(start, 2),
    optionKey: 'standard',
    petCount: 1,
    estCost: 200,
    status: over.status ?? 'confirmed',
  });
}

const cancel = async (env: Env, id: string) =>
  app.request(
    `/api/${SLUG}/bookings/${id}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${await endUserToken(env, SLUG, 'jess@example.com')}` },
    },
    env,
  );

/** Just the Resend calls — the cancel path also talks to Google when a calendar is connected. */
const resendCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([u]) => String(u).includes('api.resend.com'));

describe('the cancel route notifies the sitter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emails the tenant contact address for a fee-bearing cancel', async () => {
    const { env: base, raw } = createTestEnv();
    const env = configuredEnv(base);
    seedBoardingTiers(raw);
    raw.exec(
      `UPDATE Tenants SET ContactEmail = 'hello@sunnypaws.example' WHERE Id = 'tnt_sunnypaws'`,
    );
    const id = await seedBooking(env);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    expect((await cancel(env, id)).status).toBe(200);

    const calls = resendCalls(spy);
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body.to).toBe('hello@sunnypaws.example');
    expect(body.from).toBe('Pawservation <booking@x.com>');
    expect(body.subject).toContain('Cancelled: Boarding for Jess Demo');
    expect(body.html).toContain('Cancellation fee: $100'); // the STORED fee
    expect(body.html).toContain('jess@example.com');
  });

  it('falls back to the sitter login when the tenant has no contact email', async () => {
    const { env: base, raw } = createTestEnv();
    const env = configuredEnv(base);
    // The seeded tenant has ContactEmail NULL — the common case, and the whole reason for the
    // fallback: contact-email-only would silently never notify most accounts.
    const contact = raw
      .prepare(`SELECT ContactEmail FROM Tenants WHERE Id = 'tnt_sunnypaws'`)
      .get() as { ContactEmail: string | null };
    expect(contact.ContactEmail).toBeNull();

    const id = await seedBooking(env, { status: 'pending' });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await cancel(env, id)).status).toBe(200);

    const body = JSON.parse((resendCalls(spy)[0][1] as RequestInit).body as string);
    expect(body.to).toBe('admin@sunnypaws.example'); // TenantUsers.Email, from sql/seed.sql
    expect(body.subject).toContain('Withdrawn: Boarding request from Jess Demo');
  });

  it('treats a blank contact email as unset rather than as an address', async () => {
    const { env: base, raw } = createTestEnv();
    const env = configuredEnv(base);
    raw.exec(`UPDATE Tenants SET ContactEmail = '   ' WHERE Id = 'tnt_sunnypaws'`);
    const id = await seedBooking(env);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await cancel(env, id);
    const body = JSON.parse((resendCalls(spy)[0][1] as RequestInit).body as string);
    expect(body.to).toBe('admin@sunnypaws.example');
  });

  it('sends nothing when email is not configured, and still cancels', async () => {
    const { env, raw } = createTestEnv(); // no RESEND_* vars — the local-dev shape
    seedBoardingTiers(raw);
    const id = await seedBooking(env);
    const spy = vi.spyOn(globalThis, 'fetch');
    expect((await cancel(env, id)).status).toBe(200);
    expect(resendCalls(spy).length).toBe(0);
  });

  it('a throwing transport does NOT fail the cancellation', async () => {
    const { env: base, raw } = createTestEnv();
    const env = configuredEnv(base);
    seedBoardingTiers(raw);
    const id = await seedBooking(env);
    // Resend hard-down. The customer has already been told; the row is already written.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('resend is down'));

    const res = await cancel(env, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled', cancellationFee: 100 });
    const row = (await env.PAWSERVATION_DB.prepare(
      'SELECT Status, CancellationFee FROM BookingRequests WHERE Id = ?',
    )
      .bind(id)
      .first()) as { Status: string; CancellationFee: number };
    expect(row).toMatchObject({ Status: 'cancelled', CancellationFee: 100 });
  });

  it('a Resend 500 does not fail the cancellation either', async () => {
    const { env: base, raw } = createTestEnv();
    const env = configuredEnv(base);
    seedBoardingTiers(raw);
    const id = await seedBooking(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    expect((await cancel(env, id)).status).toBe(200);
  });

  it('a tenant with no contact email AND no sitter login is skipped, not errored', async () => {
    const { env: base, raw } = createTestEnv();
    const env = configuredEnv(base);
    raw.exec(`DELETE FROM TenantUsers WHERE TenantId = 'tnt_sunnypaws'`);
    const id = await seedBooking(env);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await cancel(env, id)).status).toBe(200);
    expect(resendCalls(spy).length).toBe(0);
  });
});
