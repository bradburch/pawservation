/**
 * HTTP adapters for the booking operations layer.
 *
 * Every rule these routes used to hold now lives in `server/lib/booking-ops.ts` as a plain
 * callable function returning a discriminated `OpResult`. What is left here is genuinely the HTTP
 * part and nothing else: pull the untrusted values off the wire, hand them to an operation, and
 * turn its result into a response. An MCP tool calls the same operation and turns the same result
 * into a tool result — which is the whole reason for the split. A rule added to a handler in this
 * file is a rule an agent cannot reach; put it in the operations layer.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  cancelBooking,
  createBooking,
  editBooking,
  getMe,
  listMyBookings,
  monthGrid,
  quoteBooking,
  type BookingOpsContext,
  type OpResult,
} from '../lib/booking-ops';
import { endUserAuth } from '../lib/middleware';
import type { AppEnv } from '../types';

/**
 * The operations context for this request. `defer` is the ONE place the Worker's
 * `executionCtx.waitUntil` is named: in production a best-effort task (calendar push, sitter
 * email) is handed to the platform; in tests there is no ExecutionContext, so the promise is
 * returned and the operation awaits it, which is what makes those paths deterministic.
 */
function opsContext(c: Context<AppEnv>): BookingOpsContext {
  return {
    env: c.env,
    tenant: c.get('tenant'),
    endUserId: c.get('endUserId'),
    defer: (task) => {
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        return task;
      }
    },
  };
}

/**
 * `OpResult` → HTTP. The failure arm's `code` is spread only when the operation set one, so a
 * refusal that never carried a code (every quote 400) stays `{ error }` on the wire exactly as it
 * always has.
 */
function respond<T>(c: Context<AppEnv>, result: OpResult<T>) {
  if (result.ok) return c.json(result.data, result.status);
  return c.json(
    result.code === undefined
      ? { error: result.error }
      : { error: result.error, code: result.code },
    result.status,
  );
}

/** Comma-joined pet ids off a query string. Pet ids are `crypto.randomUUID()` values and so
 *  comma-free by construction — the same property that makes `buildGroupKey`'s join unambiguous. */
function petIdsFromQuery(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export const bookingRoutes = new Hono<AppEnv>()
  // Scoped tightly to the booking paths so the merged middleware never guards public routes.
  .use('/:slug/me', endUserAuth)
  .use('/:slug/availability', endUserAuth)
  .use('/:slug/availability/month', endUserAuth)
  .use('/:slug/bookings', endUserAuth)
  .use('/:slug/bookings/*', endUserAuth)

  .get('/:slug/availability', async (c) =>
    respond(
      c,
      await quoteBooking(opsContext(c), {
        type: c.req.query('type'),
        optionKey: c.req.query('option') ?? '',
        start: c.req.query('start') ?? '',
        end: c.req.query('end') ?? '',
        petIds: petIdsFromQuery(c.req.query('petIds')),
        // The owner's chosen times. Present ONLY so the quote can disclose the extra-time
        // surcharge they attract (0009) — they never touch capacity or the stay's price.
        startTime: c.req.query('startTime') || null,
        departureTime: c.req.query('departureTime') || null,
        // Set by the widget while EDITING a booking, so the stay does not collide with itself.
        excludeBookingId: c.req.query('excludeBookingId'),
      }),
    ),
  )

  .get('/:slug/availability/month', async (c) =>
    respond(
      c,
      await monthGrid(opsContext(c), {
        type: c.req.query('type'),
        month: c.req.query('month') ?? '',
        optionKey: c.req.query('option'),
        petIds: petIdsFromQuery(c.req.query('petIds')),
        excludeBookingId: c.req.query('excludeBookingId'),
      }),
    ),
  )

  .get('/:slug/me', async (c) => respond(c, await getMe(opsContext(c))))

  .post('/:slug/bookings', async (c) => {
    const body = await c.req
      .json<{
        type?: string;
        startDate?: string;
        endDate?: string;
        optionKey?: string;
        petIds?: unknown;
        answers?: unknown;
        startTime?: unknown;
        departureTime?: unknown;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const rawPetIds = Array.isArray(body.petIds)
      ? body.petIds.filter((x): x is string => typeof x === 'string')
      : [];
    const rawAnswers = body.answers;
    const answers: Record<string, string> =
      rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
        ? Object.fromEntries(
            Object.entries(rawAnswers as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};
    return respond(
      c,
      await createBooking(opsContext(c), {
        type: body.type,
        startDate: body.startDate,
        endDate: body.endDate,
        optionKey: body.optionKey,
        petIds: [...new Set(rawPetIds)],
        answers,
        startTime:
          typeof body.startTime === 'string' && body.startTime !== '' ? body.startTime : null,
        departureTime:
          typeof body.departureTime === 'string' && body.departureTime !== ''
            ? body.departureTime
            : null,
        idempotencyKey: c.req.header('Idempotency-Key')?.trim() || null,
      }),
    );
  })

  /**
   * The customer changes their own booking: dates, which pets, arrival time, intake answers.
   * Deliberately NOT the service — `editBooking` reads the service and its option off the stored
   * row and never looks at the body for them, so a `type` here is inert rather than rejected.
   */
  .put('/:slug/bookings/:id', async (c) => {
    const body = await c.req
      .json<{
        startDate?: string;
        endDate?: string;
        petIds?: unknown;
        answers?: unknown;
        startTime?: unknown;
        departureTime?: unknown;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const rawPetIds = Array.isArray(body.petIds)
      ? body.petIds.filter((x): x is string => typeof x === 'string')
      : [];
    const rawAnswers = body.answers;
    const answers: Record<string, string> =
      rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
        ? Object.fromEntries(
            Object.entries(rawAnswers as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};
    return respond(
      c,
      await editBooking(opsContext(c), {
        bookingId: c.req.param('id'),
        startDate: body.startDate,
        endDate: body.endDate,
        petIds: [...new Set(rawPetIds)],
        answers,
        startTime:
          typeof body.startTime === 'string' && body.startTime !== '' ? body.startTime : null,
        departureTime:
          typeof body.departureTime === 'string' && body.departureTime !== ''
            ? body.departureTime
            : null,
      }),
    );
  })

  .post('/:slug/bookings/:id/cancel', async (c) =>
    // Reads NO request body at all: the fee is the server's to compute from the sitter's stored
    // policy, so there is nothing here for a client to supply and nothing for it to get wrong.
    respond(c, await cancelBooking(opsContext(c), { bookingId: c.req.param('id') })),
  )

  .get('/:slug/bookings/mine', async (c) => respond(c, await listMyBookings(opsContext(c))));
