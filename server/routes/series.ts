/**
 * HTTP adapters for a client's own series: list hers, quote one, request one. Every rule lives in
 * `server/lib/series-ops.ts`; this file pulls the untrusted values off the wire and turns the
 * operation's result into a response, exactly as `routes/bookings.ts` does for single bookings.
 *
 * Mounted under the tenant middleware `index.ts` already applies to `/api/:slug/*`, behind the same
 * `endUserAuth` (widget session or personal access token) the booking routes use — scoped to the
 * series paths only, so it never guards anything else.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { listMySeries, quoteSeries, requestSeries, type SeriesInput } from '../lib/series-ops';
import { endUserAuth } from '../lib/middleware';
import type { AppEnv } from '../types';
import { listRange, opsContext, respond } from './bookings';

async function seriesInput(c: Context<AppEnv>): Promise<SeriesInput> {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const rawPetIds = Array.isArray(b.petIds)
    ? b.petIds.filter((x): x is string => typeof x === 'string')
    : [];
  const rawAnswers = b.answers;
  const answers: Record<string, string> =
    rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
      ? Object.fromEntries(
          Object.entries(rawAnswers as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return {
    type: b.type,
    optionKey: b.optionKey,
    petIds: [...new Set(rawPetIds)],
    weekdays: b.weekdays,
    startTime: typeof b.startTime === 'string' && b.startTime !== '' ? b.startTime : null,
    startDate: b.startDate,
    endDate: b.endDate,
    answers,
  };
}

export const seriesRoutes = new Hono<AppEnv>()
  .use('/:slug/series', endUserAuth)
  .use('/:slug/series/*', endUserAuth)

  // Her own series, every status, with their walks through the window (or `?to=`, up to 24 months).
  .get('/:slug/series/mine', async (c) => {
    const range = listRange(c);
    if (!range.ok) return range.response;
    return respond(c, await listMySeries(opsContext(c), range.span));
  })

  .post('/:slug/series/quote', async (c) =>
    respond(c, await quoteSeries(opsContext(c), await seriesInput(c), { to: c.req.query('to') })),
  )

  .post('/:slug/series', async (c) =>
    respond(
      c,
      await requestSeries(
        opsContext(c),
        await seriesInput(c),
        c.req.header('Idempotency-Key')?.trim() || null,
      ),
    ),
  );
