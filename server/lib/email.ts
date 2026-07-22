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
export async function sendLoginCode(env: Env, to: string, code: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: `Your booking code: ${code}`,
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
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
  await resendPost(env, env.RESEND_FROM_BOOKING!, {
    to,
    subject: `Your booking with ${displayName} was ${statusWord}`,
    text: `${displayName} has ${statusWord} your booking (${whenText}).`,
    html: `<p>${htmlEscape(displayName)} has <strong>${statusWord}</strong> your booking (${htmlEscape(whenText)}).</p>`,
  });
}

/** Send a booking invite. Throws if email is not configured or Resend rejects the request. */
export async function sendInvite(
  env: Env,
  to: string,
  displayName: string,
  widgetUrl: string,
): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // displayName is tenant-controlled; escape it before it reaches the HTML body. widgetUrl is
  // server-built, but escape it for the attribute context as defense-in-depth. Subject and text
  // are plain-text fields in Resend's JSON API (not raw headers / not HTML), so they need no escaping.
  await resendPost(env, env.RESEND_FROM_BOOKING!, {
    to,
    subject: `You're invited to book with ${displayName}`,
    text: `${displayName} has invited you to book online. Get started here: ${widgetUrl}`,
    html: `<p>${htmlEscape(displayName)} has invited you to book online.</p><p><a href="${htmlEscape(widgetUrl)}">Book now</a></p>`,
  });
}

/** Send a one-time account-setup link. Throws if email is not configured or Resend rejects. */
export async function sendSignupLink(env: Env, to: string, url: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // url is server-built, but escape it for the attribute context as defense-in-depth (per
  // sendInvite). Subject/text are plain-text JSON fields in Resend's API — no escaping needed.
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: 'Finish setting up your Pawservation account',
    text: `Finish setting up your Pawservation account: ${url}\n\nThis link expires in 30 minutes. If you didn't request it, ignore this email.`,
    html: `<p><a href="${htmlEscape(url)}">Finish setting up your Pawservation account</a></p><p>This link expires in 30 minutes. If you didn&#39;t request it, ignore this email.</p>`,
  });
}

/**
 * Send a sitter their owner-console invite: a welcome + the 7-day setup link + a self-serve
 * fallback. From RESEND_FROM_NOREPLY (account-lifecycle mail, per the #41 sender split). Throws
 * if email is not configured or Resend rejects.
 */
export async function sendSitterInvite(env: Env, to: string, url: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // url is server-built, but escape it for the attribute context as defense-in-depth (per
  // sendSignupLink). The fallback origin is derived from the same url. Subject/text are plain-text
  // JSON fields in Resend's API — no escaping needed.
  const origin = new URL(url).origin;
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: "You're invited to set up your Pawservation account",
    text:
      `You've been invited to Pawservation. Set up your account here: ${url}\n\n` +
      `This link expires in 7 days. Link expired? Go to ${origin}/admin, choose "New here" and enter this email address.`,
    html:
      `<p>You&#39;ve been invited to Pawservation.</p>` +
      `<p><a href="${htmlEscape(url)}">Set up your account</a></p>` +
      `<p>This link expires in 7 days. Link expired? Go to ${htmlEscape(origin)}/admin, choose &ldquo;New here&rdquo; and enter this email address.</p>`,
  });
}

/** Send a one-time password-reset link. Throws if email is not configured or Resend rejects. */
export async function sendResetLink(env: Env, to: string, url: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  // url is server-built, but escape it for the attribute context as defense-in-depth (per
  // sendInvite/sendSignupLink). Subject/text are plain-text JSON fields in Resend's API.
  await resendPost(env, env.RESEND_FROM_NOREPLY!, {
    to,
    subject: 'Reset your Pawservation password',
    text: `Reset your Pawservation password: ${url}\n\nThis link expires in 30 minutes. If you didn't request it, ignore this email.`,
    html: `<p><a href="${htmlEscape(url)}">Reset your Pawservation password</a></p><p>This link expires in 30 minutes. If you didn&#39;t request it, ignore this email.</p>`,
  });
}
