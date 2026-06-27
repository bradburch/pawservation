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

/** Send a login code. Throws if email is not configured or Resend rejects the request. */
export async function sendLoginCode(env: Env, to: string, code: string): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: `Your booking code: ${code}`,
      text: `Your verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}
