import { useState } from 'react';
import {
  adminApi,
  ApiError,
  type BackfillFlagReason,
  type BackfillImportResult,
  type BackfillPreview,
} from '../shared-ui/api.js';
import { formatFriendlyDate } from '../../src/shared/index.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/** What the sitter should actually DO about each flag reason — see the design doc's flag table.
 *  `no-pets` isn't in that table (the classifier's own catch-all for a title naming no pet at
 *  all, or one that isn't on record), so it gets a plain fallback heading rather than pretending
 *  to be one of the four named reasons. `unpriced-set` is kept for type parity with the server's
 *  closed `FlagReason` union, though the classifier now answers an unpriced-but-otherwise-resolved
 *  event as `needs-price` instead of this flag. */
const FLAG_HEADINGS: Record<BackfillFlagReason, string> = {
  'ambiguous-pet': 'Two pets share a name — rename one',
  'multiple-households': 'Pets from different clients on one event',
  'unknown-service': 'No service in the title',
  'unpriced-set': 'No rate set for this combination of pets',
  'no-pets': "Couldn't find a pet on your list in the title",
};

/** Whole dollars only, at least $1 — the same rule the server enforces on every price this panel
 *  sends. This copy is UX only (matches PaymentsPanel's `isValidRate` idiom); the server still
 *  validates independently and refuses a fraction with 400. */
function isWholeDollar(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function eventWhen(startDate: string, endDate: string | null): string {
  return endDate
    ? `${formatFriendlyDate(startDate)} – ${formatFriendlyDate(endDate)}`
    : formatFriendlyDate(startDate);
}

/**
 * Read-only adoption of a sitter's existing Google Calendar events as bookings
 * (docs/superpowers/specs/2026-08-09-calendar-backfill-design.md). Same preview → tick what you
 * want → import shape as `VenmoImportPanel`: nothing is written until Adopt is pressed, and the
 * server re-derives every event from scratch at import time — the browser only ever names WHICH
 * event ids to adopt and, optionally, the sitter's own price for each.
 *
 * Every adopted cost is an ESTIMATE off today's rate card, never a figure a client agreed to
 * (CLAUDE.md's "the model never computes money" is about the assistant surfaces; this is the
 * separate, explicit exception the design doc carves out for the sitter's own historical pricing
 * decision). That is why every price shown here — rate-card or sitter-typed — stays editable
 * right up to the Adopt click, and why an already-adopted booking's cost stays correctable
 * afterward via `adminApi.bookings.updateCost` (see BookingsSection's "estimate" label).
 */
export function CalendarBackfillPanel({
  session,
  onImported,
  handleError,
  clearError,
}: {
  session: Session;
  onImported: () => void | Promise<void>;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  // Ticked ADOPT rows only — matches VenmoImportPanel's `matched` treatment: every adopt row
  // starts ticked, since it's already fully resolved and priced. A needs-price row has nothing to
  // tick; typing a valid price on it IS the "include this" signal (see `toImport` below).
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Every price the sitter can see or edit, adopt AND needs-price rows alike, keyed by eventId.
  // An adopt row starts prefilled with the rate card's own figure — still editable, because the
  // sitter may be correcting an old stay whose rate has changed since. A needs-price row starts
  // empty: the server has no number to offer, and none is ever guessed on its behalf.
  const [prices, setPrices] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackfillImportResult | null>(null);
  // eventIds of an in-flight PER-ROW adopt — separate from `busy`, which covers preview/bulk
  // import, so working one row doesn't grey out every other row's own button.
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());
  // A per-row adopt's own failure (the server's `skipped` reason for that one event, or a thrown
  // ApiError's message) — shown on that row only, cleared the moment the row is retried.
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  // null = "All pets". Narrows the adopt/needsPrice/flagged lists to rows involving one pet, so a
  // sitter with 53 rows in one month can work through them one animal at a time.
  const [petFilter, setPetFilter] = useState<string | null>(null);

  const reset = () => {
    setPreview(null);
    setChecked(new Set());
    setPrices(new Map());
    setRowBusy(new Set());
    setRowErrors(new Map());
    setPetFilter(null);
  };

  const runPreview = async () => {
    if (!from || !to || busy) return;
    clearError();
    setResult(null);
    setBusy(true);
    try {
      const next = await adminApi.calendarBackfill.preview(session.slug, session.token, from, to);
      setPreview(next);
      setChecked(new Set(next.adopt.map((r) => r.eventId)));
      setPrices(
        new Map([
          ...next.adopt.map((r) => [r.eventId, String(r.estCost)] as const),
          ...next.needsPrice.map((r) => [r.eventId, ''] as const),
        ]),
      );
    } catch (e) {
      reset();
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (eventId: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });

  const setPrice = (eventId: string, value: string) =>
    setPrices((prev) => new Map(prev).set(eventId, value));

  // Every pet named on an adopt or needs-price row, sorted — the filter's own option list.
  // "All pets" is represented by petFilter === null, not a row in this array.
  const petOptions = preview
    ? [
        ...new Set([
          ...preview.adopt.flatMap((r) => r.petNames),
          ...preview.needsPrice.flatMap((r) => r.petNames),
        ]),
      ].sort((a, b) => a.localeCompare(b))
    : [];

  // Loose, case/punctuation-insensitive containment — same normalisation idiom as the server's
  // own `nameKey` (calendar-backfill.ts), but UI-only and best-effort: a flagged row carries no
  // resolved petIds/petNames (pet resolution is often exactly what failed), so its summary text
  // is the only signal available to narrow it by pet. Never used to decide money or eligibility,
  // only which rows the filter shows.
  const summaryNames = (summary: string) => summary.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matchesFilter = (petNames: string[]) => petFilter === null || petNames.includes(petFilter);

  const visibleAdopt = preview ? preview.adopt.filter((r) => matchesFilter(r.petNames)) : [];
  const visibleNeedsPrice = preview
    ? preview.needsPrice.filter((r) => matchesFilter(r.petNames))
    : [];
  const visibleFlags = preview
    ? petFilter === null
      ? preview.flags
      : preview.flags.filter((f) => summaryNames(f.summary).includes(summaryNames(petFilter)))
    : [];

  // Ticked adopt rows (their price is always sent — harmlessly matching the rate card's own
  // figure when the sitter never touched it) plus every needs-price row that has a VALID
  // whole-dollar price typed in. A needs-price row with no price, or an unparseable one, is never
  // included — the same "never adopted at a number this server invented" rule the design doc
  // states for the server side, enforced here too so the sitter never gets as far as a 400 for it.
  //
  // Scoped to the VISIBLE (post-filter) rows only — filtering to one pet and then hitting bulk
  // Adopt must never sweep in rows the sitter can't currently see.
  const toImport = (): { eventId: string; estCost?: number }[] => {
    const rows: { eventId: string; estCost?: number }[] = [];
    for (const r of visibleAdopt) {
      if (!checked.has(r.eventId)) continue;
      const raw = prices.get(r.eventId) ?? '';
      rows.push({ eventId: r.eventId, ...(isWholeDollar(raw) ? { estCost: Number(raw) } : {}) });
    }
    for (const r of visibleNeedsPrice) {
      const raw = prices.get(r.eventId) ?? '';
      if (!isWholeDollar(raw)) continue;
      rows.push({ eventId: r.eventId, estCost: Number(raw) });
    }
    return rows;
  };

  const pending = toImport();
  // A ticked adopt row whose price field the sitter cleared or broke blocks Adopt entirely,
  // rather than silently falling back to the rate card's figure behind their back or silently
  // dropping just that one row. Scoped to visible rows, same as `toImport`.
  const hasInvalidPrice = visibleAdopt.some(
    (r) => checked.has(r.eventId) && !isWholeDollar(prices.get(r.eventId) ?? ''),
  );

  const runImport = async () => {
    if (!preview || pending.length === 0 || busy || hasInvalidPrice) return;
    clearError();
    setBusy(true);
    try {
      const imported = await adminApi.calendarBackfill.import(
        session.slug,
        session.token,
        from,
        to,
        pending,
      );
      setResult(imported);
      reset();
      await onImported();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  // Adopt exactly one event — the same import call the bulk path makes, with a single-entry list.
  // On success the row is dropped from `preview` in place (never a full re-preview, so every OTHER
  // row keeps its typed price and the sitter keeps their place in a long list). A price is sent
  // only when the row's own field currently holds a valid whole dollar amount; the caller (the
  // button's `disabled`) guarantees that's true whenever this runs.
  const adoptOne = async (eventId: string, estCost: number) => {
    if (rowBusy.has(eventId) || busy) return;
    clearError();
    setRowBusy((prev) => new Set(prev).add(eventId));
    setRowErrors((prev) => {
      if (!prev.has(eventId)) return prev;
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    try {
      const outcome = await adminApi.calendarBackfill.import(
        session.slug,
        session.token,
        from,
        to,
        [{ eventId, estCost }],
      );
      if (outcome.imported > 0) {
        setPreview((prev) =>
          prev
            ? {
                ...prev,
                adopt: prev.adopt.filter((r) => r.eventId !== eventId),
                needsPrice: prev.needsPrice.filter((r) => r.eventId !== eventId),
              }
            : prev,
        );
        setChecked((prev) => {
          if (!prev.has(eventId)) return prev;
          const next = new Set(prev);
          next.delete(eventId);
          return next;
        });
        await onImported();
      } else {
        const reason = outcome.skipped[0]?.reason ?? 'Could not adopt that event.';
        setRowErrors((prev) => new Map(prev).set(eventId, reason));
      }
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not adopt that event.';
      setRowErrors((prev) => new Map(prev).set(eventId, message));
    } finally {
      setRowBusy((prev) => {
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
    }
  };

  const flagGroups = new Map<BackfillFlagReason, BackfillPreview['flags']>();
  for (const f of visibleFlags) {
    const list = flagGroups.get(f.reason) ?? [];
    list.push(f);
    flagGroups.set(f.reason, list);
  }

  const nothingFound =
    preview !== null &&
    preview.adopt.length === 0 &&
    preview.needsPrice.length === 0 &&
    preview.flags.length === 0;

  // Distinct from `nothingFound`: the preview itself found rows, but the current pet filter hides
  // all of them. Told apart so the sitter isn't led to believe the range was empty.
  const nothingVisible =
    preview !== null &&
    !nothingFound &&
    petFilter !== null &&
    visibleAdopt.length === 0 &&
    visibleNeedsPrice.length === 0 &&
    visibleFlags.length === 0;

  return (
    <div className="pb-venmo-import">
      <h3>
        Adopt past bookings from your calendar
        <Hint label="Adopting from your calendar">
          Reads events already on your connected Google Calendar over the range you choose and shows
          you what it can bring in as bookings. Nothing on your calendar is ever changed — this only
          reads it — and nothing here is recorded until you press Adopt.
        </Hint>
      </h3>
      <p className="pb-applies">
        Every cost below is an estimate off today&rsquo;s rate card, not a figure any client ever
        agreed to — your rates may have moved since. Edit any price before adopting, or correct it
        later from Bookings.
      </p>

      <div className="pb-row">
        <label className="pb-inline">
          From
          <input
            type="date"
            value={from}
            disabled={busy}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="pb-inline">
          To
          <input type="date" value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={() => void runPreview()} disabled={busy || !from || !to}>
          {busy && !preview ? 'Checking…' : 'Preview'}
        </button>
        {preview && (
          <button onClick={reset} disabled={busy}>
            Start over
          </button>
        )}
      </div>

      {result && (
        <p className="pb-applies" role="status">
          Adopted {result.imported} booking{result.imported === 1 ? '' : 's'}.
          {result.skipped.length > 0
            ? ` ${result.skipped.length} skipped: ${result.skipped
                .map((s) => s.reason)
                .join('; ')}.`
            : ''}
        </p>
      )}

      {preview && petOptions.length > 0 && (
        <div className="pb-row">
          <label className="pb-inline">
            Pet
            <select
              value={petFilter ?? ''}
              disabled={busy}
              onChange={(e) => setPetFilter(e.target.value || null)}
            >
              <option value="">All pets</option>
              {petOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {preview && (
        <>
          {nothingFound && (
            <p className="pb-hint">Nothing to adopt in that range — see below for why.</p>
          )}
          {nothingVisible && <p className="pb-hint">No events for {petFilter} in that range.</p>}

          {visibleAdopt.length > 0 && (
            <>
              <h4>Ready to adopt ({visibleAdopt.length})</h4>
              <ul>
                {visibleAdopt.map((r) => {
                  const raw = prices.get(r.eventId) ?? '';
                  const priceInvalid = !isWholeDollar(raw);
                  const invalid = checked.has(r.eventId) && priceInvalid;
                  const busyRow = rowBusy.has(r.eventId);
                  return (
                    <li key={r.eventId}>
                      <label className="pb-inline">
                        <input
                          type="checkbox"
                          checked={checked.has(r.eventId)}
                          onChange={() => toggle(r.eventId)}
                        />{' '}
                        {r.summary} — {eventWhen(r.startDate, r.endDate)}
                      </label>{' '}
                      <label className="pb-inline">
                        $
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={raw}
                          disabled={busy || busyRow}
                          onChange={(e) => setPrice(r.eventId, e.target.value)}
                          aria-label={`Price for ${r.summary}`}
                        />
                      </label>{' '}
                      <button
                        onClick={() => void adoptOne(r.eventId, Number(raw))}
                        disabled={busy || busyRow || priceInvalid}
                      >
                        {busyRow ? 'Adopting…' : 'Adopt'}
                      </button>
                      {invalid && <span className="pb-hint"> — enter a whole-dollar amount</span>}
                      {rowErrors.has(r.eventId) && (
                        <p className="pb-error">{rowErrors.get(r.eventId)}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {visibleNeedsPrice.length > 0 && (
            <>
              <h4>Adoptable once priced ({visibleNeedsPrice.length})</h4>
              <p className="pb-hint">
                Your rate card doesn&rsquo;t cover this combination of pets yet — nothing is guessed
                on your behalf. Type a price to adopt it now (this doesn&rsquo;t add the rate to
                your card, it just prices this one stay).
              </p>
              <ul>
                {visibleNeedsPrice.map((r) => {
                  const raw = prices.get(r.eventId) ?? '';
                  const priceInvalid = !isWholeDollar(raw);
                  const busyRow = rowBusy.has(r.eventId);
                  return (
                    <li key={r.eventId}>
                      {r.summary} — {eventWhen(r.startDate, r.endDate)}{' '}
                      <label className="pb-inline">
                        $
                        <input
                          type="number"
                          min={1}
                          step={1}
                          placeholder="price"
                          value={raw}
                          disabled={busy || busyRow}
                          onChange={(e) => setPrice(r.eventId, e.target.value)}
                          aria-label={`Price for ${r.summary}`}
                        />
                      </label>{' '}
                      <button
                        onClick={() => void adoptOne(r.eventId, Number(raw))}
                        disabled={busy || busyRow || priceInvalid}
                      >
                        {busyRow ? 'Adopting…' : 'Adopt'}
                      </button>
                      {rowErrors.has(r.eventId) && (
                        <p className="pb-error">{rowErrors.get(r.eventId)}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {visibleFlags.length > 0 && (
            <>
              <h4>Needs a fix first ({visibleFlags.length})</h4>
              {[...flagGroups.entries()].map(([reason, flags]) => (
                <div key={reason}>
                  <p>
                    <strong>{FLAG_HEADINGS[reason]}</strong>
                  </p>
                  <ul>
                    {flags.map((f) => (
                      <li key={f.eventId} className="pb-hint">
                        {f.summary} ({formatFriendlyDate(f.startDate)}) — {f.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}

          {preview.skipped > 0 && (
            <p className="pb-hint">
              {preview.skipped} event{preview.skipped === 1 ? '' : 's'} in this range{' '}
              {preview.skipped === 1 ? 'is' : 'are'} already on Pawservation or{' '}
              {preview.skipped === 1 ? 'was' : 'were'} adopted before, and{' '}
              {preview.skipped === 1 ? 'is' : 'are'} left alone.
            </p>
          )}

          {(visibleAdopt.length > 0 || visibleNeedsPrice.length > 0) && (
            <div className="pb-row">
              <button
                onClick={() => void runImport()}
                disabled={busy || pending.length === 0 || hasInvalidPrice}
              >
                {busy
                  ? 'Adopting…'
                  : `Adopt ${pending.length} booking${pending.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
