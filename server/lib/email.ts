/**
 * Transactional email via Resend's REST API (https://resend.com) — chosen over the Cloudflare
 * `send_email` binding because Resend has a free tier that works on the Workers FREE plan, whereas
 * Cloudflare Email Sending requires Workers Paid.
 *
 * Configured by two secrets (`wrangler secret put`): RESEND_API_KEY and RESEND_FROM (a verified
 * "Name <addr@your-domain>" sender). When RESEND_API_KEY is absent — local dev — email is not
 * configured and the caller falls back to returning the code on screen (see routes/auth.ts).
 */

export function isEmailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
}

/** Escape a value for interpolation into an HTML email body (tenant-controlled text is untrusted). */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resendPost(env: Env, body: Record<string, unknown>): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM, ...body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}

/** Send a login code. Throws if email is not configured or Resend rejects the request. */
export async function sendLoginCode(env: Env, to: string, code: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  await resendPost(env, {
    to,
    subject: `Your booking code: ${code}`,
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
  });
}

/** Notify a customer their booking status changed. Throws if email is not configured or Resend rejects the request. */
export async function sendBookingStatusEmail(
  env: Env,
  to: string,
  displayName: string,
  statusWord: 'confirmed' | 'declined' | 'cancelled',
  whenText: string,
): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  await resendPost(env, {
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
  await resendPost(env, {
    to,
    subject: `You're invited to book with ${displayName}`,
    text: `${displayName} has invited you to book online. Get started here: ${widgetUrl}`,
    html: `<p>${htmlEscape(displayName)} has invited you to book online.</p><p><a href="${htmlEscape(widgetUrl)}">Book now</a></p>`,
  });
}
