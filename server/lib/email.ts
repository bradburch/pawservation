/**
 * Transactional email via Resend's REST API (https://resend.com) — chosen over the Cloudflare
 * `send_email` binding because Resend has a free tier that works on the Workers FREE plan, whereas
 * Cloudflare Email Sending requires Workers Paid.
 *
 * Configured by three secrets (`wrangler secret put`): RESEND_API_KEY, and two verified
 * "Name <addr@your-domain>" senders — RESEND_FROM_NOREPLY for account-access mail (login codes,
 * password resets, signup links) and RESEND_FROM_BOOKING for booking-related mail (invites,
 * confirm/decline/cancel notices). All three are required, or email is treated as unconfigured
 * and the caller falls back to returning the code/link on screen (see routes/auth.ts).
 */

export function isEmailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_NOREPLY && env.RESEND_FROM_BOOKING);
}

/** Escape a value for interpolation into an HTML email body (tenant-controlled text is untrusted). */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Brand tokens for the shared mail shell — mirror the admin/landing palette (--leaf, --ink,
// --soft, --line in app/admin/admin.css). Inline styles only: email clients strip <style>
// blocks, and a strict no-external-assets rule (no hosted images/fonts) keeps every mail
// self-contained.
const EMAIL_ACCENT = '#2e6440';
const EMAIL_FONTS =
  "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Shared HTML shell for every outgoing mail: accent bar, one 🐾 brand line, a 560px column,
 * system font stack, optional footer. `bodyHtml` is trusted markup built by the senders below
 * (they escape their own interpolations); `footer` is often tenant-controlled ("on behalf of
 * {DisplayName}"), so the shell escapes it itself. Exported for unit tests.
 */
export function emailShell(bodyHtml: string, footer?: string): string {
  return (
    `<div style="margin:0 auto;max-width:560px;font-family:${EMAIL_FONTS};color:#18271d;line-height:1.55;">` +
    `<div style="height:4px;background:${EMAIL_ACCENT};"></div>` +
    `<p style="margin:18px 0 0;font-size:14px;font-weight:700;color:${EMAIL_ACCENT};">🐾 Pawservation</p>` +
    `<div style="margin:20px 0 0;">${bodyHtml}</div>` +
    (footer
      ? `<p style="margin:28px 0 12px;padding-top:12px;border-top:1px solid #e3e7e0;font-size:13px;color:#697a6d;">${htmlEscape(footer)}</p>`
      : '') +
    `</div>`
  );
}

/**
 * A button-styled link. Escapes both the URL (attribute context, defense-in-depth — all callers
 * pass server-built URLs) and the label, so call sites cannot forget. Exported for unit tests.
 */
export function emailButton(url: string, label: string): string {
  return (
    `<p style="margin:20px 0;"><a href="${htmlEscape(url)}" ` +
    `style="display:inline-block;background:${EMAIL_ACCENT};color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;">` +
    `${htmlEscape(label)}</a></p>`
  );
}

async function resendPost(env: Env, from: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, ...body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}

/** Send a login code. Throws if email is not configured or Resend rejects the request. */
export async function sendLoginCode(
  env: Env,
  to: string,
  code: string,
  displayName: string,
): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // displayName is tenant-controlled → escaped in HTML. code is server-generated digits
  // (from generateCode in routes/auth.ts) interpolated as-is — no escaping needed. Subject/text
  // are plain-text JSON fields in Resend's API — no escaping needed.
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: `Your booking code: ${code}`,
    text:
      `Your code to sign in and book with ${displayName} is ${code}. It expires in 10 minutes.\n\n` +
      `If you didn't try to sign in, you can ignore this email.`,
    html: emailShell(
      `<p style="margin:0 0 8px;">Your code to sign in and book with <strong>${htmlEscape(displayName)}</strong>:</p>` +
        `<p style="margin:12px 0;font-size:28px;font-weight:800;letter-spacing:6px;">${code}</p>` +
        `<p style="margin:8px 0 0;">It expires in 10 minutes. If you didn&#39;t try to sign in, you can ignore this email.</p>`,
      `Sent by Pawservation on behalf of ${displayName}`,
    ),
  });
}

/**
 * Tell the customer their request was confirmed/declined or their booking cancelled.
 * Throws if email is not configured or Resend rejects the request.
 */
export async function sendBookingStatusEmail(
  env: Env,
  to: string,
  displayName: string,
  statusWord: 'confirmed' | 'declined' | 'cancelled',
  whenText: string,
): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // displayName and whenText are tenant/user-controlled → escaped in HTML. statusWord is one of
  // three code literals (confirmed/declined/cancelled) — safe unescaped. Subject/text are
  // plain-text JSON fields in Resend's API — no escaping needed.
  await resendPost(env, env.RESEND_FROM_BOOKING!, {
    to,
    subject: `Your booking with ${displayName} was ${statusWord}`,
    text:
      `${displayName} has ${statusWord} your booking (${whenText}).\n\n` +
      `You can review your bookings anytime on ${displayName}'s booking page — sign in with this email address.`,
    html: emailShell(
      `<p style="margin:0 0 8px;">${htmlEscape(displayName)} has <strong>${statusWord}</strong> your booking (${htmlEscape(whenText)}).</p>` +
        `<p style="margin:8px 0 0;">You can review your bookings anytime on ${htmlEscape(displayName)}&#39;s booking page &mdash; sign in with this email address.</p>`,
      `Sent by Pawservation on behalf of ${displayName}`,
    ),
  });
}

/** Send a booking invite (on-demand customer welcome). Throws if email is not configured or Resend rejects the request. */
export async function sendInvite(
  env: Env,
  to: string,
  displayName: string,
  widgetUrl: string,
): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // displayName is tenant-controlled → escaped in HTML. widgetUrl is server-built, but escaped
  // for attribute context as defense-in-depth. Subject/text are plain-text JSON fields in
  // Resend's API — no escaping needed.
  await resendPost(env, env.RESEND_FROM_BOOKING!, {
    to,
    subject: `You're set up to book with ${displayName}`,
    text:
      `${displayName} uses Pawservation to take booking requests online — and you're on their client list.\n\n` +
      `Request a stay, a walk or a visit for your pets here: ${widgetUrl}\n\n` +
      `Sign in with this email address and we'll send you a one-time code — no password to remember. Your sitter reviews every request personally, so nothing is booked until they confirm.`,
    html: emailShell(
      `<p style="margin:0 0 8px;"><strong>${htmlEscape(displayName)}</strong> uses Pawservation to take booking requests online &mdash; and you&#39;re on their client list.</p>` +
        `${emailButton(widgetUrl, 'Request a booking')}` +
        `<p style="margin:8px 0 0;">Sign in with this email address and we&#39;ll send you a one-time code &mdash; no password to remember. Your sitter reviews every request personally, so nothing is booked until they confirm.</p>`,
      `Sent by Pawservation on behalf of ${displayName}`,
    ),
  });
}

/** Send a one-time account-setup link. Throws if email is not configured or Resend rejects. */
export async function sendSignupLink(env: Env, to: string, url: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // url is server-built, but escaped for attribute/text context as defense-in-depth. Subject/text
  // are plain-text JSON fields in Resend's API — no escaping needed.
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: 'Finish setting up your Pawservation account',
    text:
      `You're almost there. Pawservation gives your pet-care business its own booking page: clients you choose request stays, walks and visits online, and you confirm or decline each one — your calendar stays yours.\n\n` +
      `Finish setting up your account: ${url}\n\n` +
      `This link expires in 30 minutes. If you didn't request it, ignore this email.\n\n` +
      `See how it works: https://pawservation.com/how-it-works`,
    html: emailShell(
      `<p style="margin:0 0 8px;">You&#39;re almost there. <strong>Pawservation</strong> gives your pet-care business its own booking page: clients you choose request stays, walks and visits online, and you confirm or decline each one &mdash; your calendar stays yours.</p>` +
        `${emailButton(url, 'Finish setting up')}` +
        `<p style="margin:8px 0 0;">This link expires in 30 minutes. If you didn&#39;t request it, ignore this email.</p>` +
        `<p style="margin:16px 0 0;"><a href="https://pawservation.com/how-it-works" style="color:#2e6440;">See how Pawservation works</a></p>`,
      'Sent by Pawservation',
    ),
  });
}

/**
 * Send a sitter their owner-console invite: a welcome + the 7-day setup link + a self-serve
 * fallback. From RESEND_FROM_NOREPLY (account-lifecycle mail, per the #41 sender split). Throws
 * if email is not configured or Resend rejects.
 */
export async function sendSitterInvite(env: Env, to: string, url: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // url and origin are server-built, but escaped for attribute/text context as defense-in-depth.
  // Subject/text are plain-text JSON fields in Resend's API — no escaping needed.
  const origin = new URL(url).origin;
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: "You've been invited to set up your Pawservation account",
    text:
      `You've been invited to Pawservation — a booking page for your pet-care business. Clients you choose request stays, walks and visits online; you confirm or decline each one, and your calendar stays yours.\n\n` +
      `Set up your account here: ${url}\n\n` +
      `This link expires in 7 days. Link expired? Go to ${origin}/admin, choose "New here" and enter this email address.\n\n` +
      `See how it works: https://pawservation.com/how-it-works`,
    html: emailShell(
      `<p style="margin:0 0 8px;">You&#39;ve been invited to <strong>Pawservation</strong> &mdash; a booking page for your pet-care business. Clients you choose request stays, walks and visits online; you confirm or decline each one, and your calendar stays yours.</p>` +
        `${emailButton(url, 'Set up your account')}` +
        `<p style="margin:8px 0 0;">This link expires in 7 days. Link expired? Go to <a href="${htmlEscape(origin)}/admin" style="color:#2e6440;">${htmlEscape(origin)}/admin</a>, choose &ldquo;New here&rdquo; and enter this email address.</p>` +
        `<p style="margin:16px 0 0;"><a href="https://pawservation.com/how-it-works" style="color:#2e6440;">See how Pawservation works</a></p>`,
      'Sent by Pawservation',
    ),
  });
}

/** Send a one-time password-reset link. Throws if email is not configured or Resend rejects. */
export async function sendResetLink(env: Env, to: string, url: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // url is server-built, but escaped for attribute/text context as defense-in-depth. Subject/text
  // are plain-text JSON fields in Resend's API — no escaping needed.
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: 'Reset your Pawservation password',
    text:
      `Someone asked to reset the password for your Pawservation account — the dashboard where you run your booking page.\n\n` +
      `Reset your password: ${url}\n\n` +
      `This link expires in 30 minutes. If you didn't request it, ignore this email — your password stays as it is.\n\n` +
      `New to Pawservation? See how it works: https://pawservation.com/how-it-works`,
    html: emailShell(
      `<p style="margin:0 0 8px;">Someone asked to reset the password for your Pawservation account &mdash; the dashboard where you run your booking page.</p>` +
        `${emailButton(url, 'Reset your password')}` +
        `<p style="margin:8px 0 0;">This link expires in 30 minutes. If you didn&#39;t request it, ignore this email &mdash; your password stays as it is.</p>` +
        `<p style="margin:16px 0 0;">New to Pawservation? <a href="https://pawservation.com/how-it-works" style="color:#2e6440;">See how it works</a></p>`,
      'Sent by Pawservation',
    ),
  });
}
