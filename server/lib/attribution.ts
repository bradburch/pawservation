/**
 * Where an invite request came from — the one question this exists to answer is which outreach
 * (a cold email, a sitter group on Reddit or Facebook, LinkedIn) produces sign-up requests.
 *
 * Three values, all optional, read where a visitor ARRIVES — `GET /` and `GET /signup`:
 * `utm_source` and `utm_campaign` off the URL the outreach link carried, and the ORIGIN of the page
 * that linked there (the Referer). The Referer worth having is the one on that arrival GET — the
 * one on the form POST is always our own page. The homepage has no form, so it carries all three
 * on its "Sign up" LINKS as query parameters (`attributionQuery`, the referrer as `ref_origin`);
 * `/signup` reads them from its query (or, arriving directly, the Referer header) and its form
 * carries them as hidden fields through every step of `POST /signup` (the Turnstile step, an error
 * re-render). Every hop makes them visitor-writable again, so every hop cleans them again with the
 * same functions: these are the trust boundary on all sides.
 *
 * The rule both share: **attribution is never a reason to refuse a sign-up.** A value that fails is
 * DROPPED (`undefined`), never a 400 — a visitor cannot fix a hidden field, and a lost tag costs us
 * a statistic while a refused form costs us the sitter.
 *
 * The referrer is reduced to its ORIGIN and never kept whole: a path can carry a thread title, a
 * profile name or a search query, and the owner's question needs only the site. Nothing here is
 * ever logged and nothing is stored; it travels only into the email the platform owner receives
 * (`sendSignupNotice`).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../types';

export type Attribution = {
  utmSource?: string;
  utmCampaign?: string;
  refOrigin?: string;
};

/** Letters, digits, `.`, `_`, `-`; at most 64. Wide enough for any tag we would write by hand
 * (`r-petsitting`, `fb_group.oct`), narrow enough that nothing in it needs escaping anywhere it
 * lands and no address, space or control character can ride in on one. */
const UTM_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** An origin longer than this is not a site anybody linked us from. */
const MAX_ORIGIN_LENGTH = 100;
/** Bound the input before `new URL` parses it: a header or a form field is attacker-sized. */
const MAX_REFERRER_INPUT = 2048;

export function cleanUtm(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return UTM_RE.test(trimmed) ? trimmed : undefined;
}

/** The referrer's `scheme://host[:port]`, or `undefined` when it is absent, unparseable, not
 * http(s), implausibly long, or this site itself (`ownOrigin`) — internal navigation is not a
 * source. */
export function cleanRefOrigin(value: unknown, ownOrigin: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REFERRER_INPUT) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const origin = url.origin;
  if (origin.length > MAX_ORIGIN_LENGTH || origin === ownOrigin) return undefined;
  return origin;
}

export function readAttribution(
  raw: { utmSource: unknown; utmCampaign: unknown; referrer: unknown },
  ownOrigin: string,
): Attribution {
  return {
    utmSource: cleanUtm(raw.utmSource),
    utmCampaign: cleanUtm(raw.utmCampaign),
    refOrigin: cleanRefOrigin(raw.referrer, ownOrigin),
  };
}

/** Attribution on ARRIVAL, from a GET: the query's UTM tags, and the referrer — the query's
 * `ref_origin` when the homepage's link carried one forward (that hop's own Referer is this site,
 * which is dropped), the Referer header otherwise. */
export function attributionFromRequest(c: Context<AppEnv>): Attribution {
  return readAttribution(
    {
      utmSource: c.req.query('utm_source'),
      utmCampaign: c.req.query('utm_campaign'),
      referrer: c.req.query('ref_origin') ?? c.req.header('Referer'),
    },
    new URL(c.req.url).origin,
  );
}

/** Attribution carried through a POST: the form's hidden fields, cleaned again (they are
 * visitor-writable), so a claim that we referred ourselves is dropped like any other. */
export function attributionFromForm(raw: Record<string, unknown>, ownOrigin: string): Attribution {
  return readAttribution(
    { utmSource: raw.utm_source, utmCampaign: raw.utm_campaign, referrer: raw.ref_origin },
    ownOrigin,
  );
}

/** The three hidden inputs, only for values present. Values are already cleaned, so they hold
 * only `[A-Za-z0-9._-]` or a URL origin — escaped regardless. */
export function attributionInputs(
  a: Attribution | undefined,
  escape: (v: string) => string,
): string {
  if (!a) return '';
  const fields: [string, string | undefined][] = [
    ['utm_source', a.utmSource],
    ['utm_campaign', a.utmCampaign],
    ['ref_origin', a.refOrigin],
  ];
  return fields
    .map(([name, value]) =>
      value
        ? `\n              <input type="hidden" name="${name}" value="${escape(value)}" />`
        : '',
    )
    .join('');
}

/** `?utm_source=…&amp;…` for an HTML `href`, from ALREADY-CLEANED values ('' when there are none):
 * how the homepage's "Sign up" links carry attribution to /signup. */
export function attributionQuery(a: Attribution): string {
  const params = new URLSearchParams();
  if (a.utmSource) params.set('utm_source', a.utmSource);
  if (a.utmCampaign) params.set('utm_campaign', a.utmCampaign);
  if (a.refOrigin) params.set('ref_origin', a.refOrigin);
  const qs = params.toString();
  return qs ? `?${qs.replace(/&/g, '&amp;')}` : '';
}
