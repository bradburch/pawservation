import { useState } from 'react';
import {
  adminApi,
  type AttributionApplyResult,
  type AttributionCandidateBooking,
  type AttributionInput,
  type AttributionPreview,
  type AttributionProposal,
  type AttributionUnresolved,
} from '../shared-ui/api.js';
import { balancedRemainder, formatFriendlyDate } from '../../src/shared/index.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/** Whole dollars only, at least $1 — same idiom as CalendarBackfillPanel's `isWholeDollar`. This
 *  is UX only; the server independently validates every split and refuses a bad one. */
function isWholeDollar(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

/** One candidate booking a credit could land on, plus the sitter's current, editable decision
 *  about it: whether it's checked (part of this attribution) and what to send for it. Starts
 *  from either a proposal's own split (checked, pre-filled) or an ambiguous credit's named
 *  candidate (unchecked, blank — nothing here is ever guessed on the sitter's behalf). */
type Row = AttributionCandidateBooking & { checked: boolean; amountText: string };

/** One credit the sitter can act on, built once from the preview response and edited in place.
 *  `included` is the master tick for this credit — independent of which rows are checked, so
 *  unticking it excludes the credit from Apply without discarding whatever the sitter typed. */
type EditableCredit = {
  paymentId: string;
  accountId: string;
  amount: number;
  paidDate: string;
  rows: Row[];
  included: boolean;
};

function fromProposal(p: AttributionProposal): EditableCredit {
  return {
    paymentId: p.paymentId,
    accountId: p.accountId,
    amount: p.amount,
    paidDate: p.paidDate,
    rows: p.splits.map((s) => ({ ...s, checked: true, amountText: String(s.amount) })),
    // A proposal can legitimately carry NO splits — an unaffordable tie the credit couldn't have
    // reached anyway is not something `proposeAttribution` refuses, it just leaves the whole
    // amount as remainder (see its own doc comment). There is nothing to check in that case, so
    // it starts un-included: ticking it would only submit an empty, server-refused attribution.
    included: p.splits.length > 0,
  };
}

function fromAmbiguous(u: AttributionUnresolved): EditableCredit {
  return {
    paymentId: u.paymentId,
    accountId: u.accountId,
    amount: u.amount,
    paidDate: u.paidDate,
    rows: u.bookings.map((b) => ({ ...b, checked: false, amountText: '' })),
    included: false,
  };
}

/**
 * The client-side mirror of `proposeAttribution`'s conservation rule
 * (`balancedRemainder`, src/shared/invoicing/attribution-splits.ts) applied to what the sitter
 * currently has checked and typed for one credit. `null` means "not submittable yet" — an
 * unusable amount on a checked row, or a total that overshoots the credit — which is exactly what
 * blocks Apply and shows the inline message, before the server ever sees it.
 */
function remainderFor(credit: EditableCredit): number | null {
  const checked = credit.rows.filter((r) => r.checked);
  if (checked.some((r) => !isWholeDollar(r.amountText))) return null;
  return balancedRemainder(
    credit.amount,
    checked.map((r) => ({ amount: Number(r.amountText) })),
  );
}

/** One credit's editable block — the split rows plus the master include tick, shared by the
 *  "ready to attribute" and "needs your call" sections below (they differ only in starting state
 *  and surrounding copy, never in how a row is edited). */
function CreditEditor({
  credit,
  label,
  busy,
  onToggleIncluded,
  onToggleRow,
  onRowAmount,
}: {
  credit: EditableCredit;
  label: string;
  busy: boolean;
  onToggleIncluded: () => void;
  onToggleRow: (bookingId: string) => void;
  onRowAmount: (bookingId: string, value: string) => void;
}) {
  const remainder = remainderFor(credit);
  const anyChecked = credit.rows.some((r) => r.checked);
  return (
    <li>
      <label className="pb-inline">
        <input
          type="checkbox"
          checked={credit.included}
          disabled={busy || !anyChecked}
          onChange={onToggleIncluded}
        />{' '}
        <strong>${credit.amount}</strong> from {label} on {formatFriendlyDate(credit.paidDate)}
      </label>
      {credit.rows.length === 0 ? (
        <p className="pb-hint">
          Nothing to attach this to yet — ${credit.amount} would stay as account credit.
        </p>
      ) : (
        <>
          <ul>
            {credit.rows.map((r) => (
              <li key={r.bookingId}>
                <label className="pb-inline">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    disabled={busy}
                    onChange={() => onToggleRow(r.bookingId)}
                  />{' '}
                  {r.serviceType} ({formatFriendlyDate(r.startDate)}) — {r.status}, ${r.outstanding}{' '}
                  outstanding
                </label>{' '}
                <label className="pb-inline">
                  $
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={r.amountText}
                    disabled={busy || !r.checked}
                    onChange={(e) => onRowAmount(r.bookingId, e.target.value)}
                    aria-label={`Amount for ${r.serviceType} on ${r.startDate}`}
                  />
                </label>
              </li>
            ))}
          </ul>
          {anyChecked &&
            (remainder === null ? (
              <p className="pb-error">These splits don&rsquo;t add up to ${credit.amount} yet.</p>
            ) : (
              <p className="pb-hint">${remainder} would stay as account credit.</p>
            ))}
        </>
      )}
    </li>
  );
}

/**
 * PREVIEW → APPROVE → APPLY for account-level credits a sitter's imported payment history left
 * unattached to any booking (docs/superpowers/specs/2026-08-10-payment-attribution-design.md).
 * Same shape as `CalendarBackfillPanel`/`CsvImportPanel`: nothing is written until Apply is
 * pressed, and the server re-derives and re-checks everything against LIVE state at that point
 * (`POST .../attribute/apply`'s own doc comment in server/routes/admin.ts) — the browser only
 * ever names which payment goes on which booking(s) and for how much.
 *
 * `proposeAttribution`'s three outcomes are kept visually distinct on purpose: a resolved
 * proposal is ticked and ready; an `ambiguous` credit is a tie the server deliberately refused to
 * break, so it starts UNticked and empty until the sitter picks a booking; `no-unpaid-bookings`
 * (and every other refusal) is a fact about the data, not something to act on, and is collapsed by
 * default — on this tenant's real numbers, 772 of 821 credits land there, and a flat list would
 * bury the ~47 the sitter can actually do something with.
 */
export function AttributionPanel({
  session,
  households,
  onApplied,
  handleError,
  clearError,
}: {
  session: Session;
  /** accountId -> a display label for it. Optional and falls back to the raw id, so the panel
   *  works even where no household roster is at hand. EarningsSection passes its own household
   *  names (built from the same `AnalyticsPayload['households']` its balances list already has),
   *  never re-fetched here. */
  households?: Map<string, string>;
  onApplied: () => void | Promise<void>;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [previewData, setPreviewData] = useState<AttributionPreview | null>(null);
  const [credits, setCredits] = useState<Map<string, EditableCredit>>(new Map());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AttributionApplyResult | null>(null);

  const label = (accountId: string) => households?.get(accountId) ?? accountId;

  const reset = () => {
    setPreviewData(null);
    setCredits(new Map());
  };

  const runPreview = async () => {
    if (busy) return;
    clearError();
    setResult(null);
    setBusy(true);
    try {
      const next = await adminApi.payments.attributePreview(session.slug, session.token);
      setPreviewData(next);
      const nextCredits = new Map<string, EditableCredit>();
      for (const p of next.proposals) nextCredits.set(p.paymentId, fromProposal(p));
      for (const u of next.unresolved)
        if (u.reason === 'ambiguous') nextCredits.set(u.paymentId, fromAmbiguous(u));
      setCredits(nextCredits);
    } catch (e) {
      reset();
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleIncluded = (paymentId: string) =>
    setCredits((prev) => {
      const credit = prev.get(paymentId);
      if (!credit) return prev;
      const next = new Map(prev);
      next.set(paymentId, { ...credit, included: !credit.included });
      return next;
    });

  const toggleRow = (paymentId: string, bookingId: string) =>
    setCredits((prev) => {
      const credit = prev.get(paymentId);
      if (!credit) return prev;
      const next = new Map(prev);
      next.set(paymentId, {
        ...credit,
        rows: credit.rows.map((r) =>
          r.bookingId === bookingId ? { ...r, checked: !r.checked } : r,
        ),
      });
      return next;
    });

  const setRowAmount = (paymentId: string, bookingId: string, value: string) =>
    setCredits((prev) => {
      const credit = prev.get(paymentId);
      if (!credit) return prev;
      const next = new Map(prev);
      next.set(paymentId, {
        ...credit,
        rows: credit.rows.map((r) => (r.bookingId === bookingId ? { ...r, amountText: value } : r)),
      });
      return next;
    });

  // Only a credit the sitter actually ticked, with at least one checked booking and a set of
  // splits that conserves, is ever sent — the same guard `applyAttribution` states for itself
  // ("names no bookings; there is nothing to attribute it to"), checked here first so an
  // untouched or half-edited credit can never ride along in the batch by accident.
  const toApply: AttributionInput[] = [];
  let hasBlockedIncluded = false;
  for (const credit of credits.values()) {
    if (!credit.included) continue;
    const checked = credit.rows.filter((r) => r.checked);
    const remainder = remainderFor(credit);
    if (checked.length === 0 || remainder === null) {
      hasBlockedIncluded = true;
      continue;
    }
    toApply.push({
      paymentId: credit.paymentId,
      accountId: credit.accountId,
      splits: checked.map((r) => ({ bookingId: r.bookingId, amount: Number(r.amountText) })),
      remainder,
    });
  }
  const totalAmount = toApply.reduce((sum, a) => {
    const credit = credits.get(a.paymentId);
    return sum + (credit?.amount ?? 0);
  }, 0);

  const runApply = async () => {
    if (busy || toApply.length === 0 || hasBlockedIncluded) return;
    clearError();
    setBusy(true);
    try {
      const outcome = await adminApi.payments.attributeApply(session.slug, session.token, toApply);
      setResult(outcome);
      const skippedIds = new Set(outcome.skipped.map((s) => s.paymentId));
      setCredits((prev) => {
        const next = new Map(prev);
        for (const a of toApply) if (!skippedIds.has(a.paymentId)) next.delete(a.paymentId);
        return next;
      });
      await onApplied();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  // Filtered against the LIVE `credits` map, not the raw preview response — a credit `runApply`
  // just removed (see its `next.delete` above) must disappear from both the list AND the count
  // beside it. Deriving straight from `previewData` left the header reading a stale "(1)" with
  // nothing rendered underneath once the sole entry had just been applied.
  const proposalIds = previewData
    ? previewData.proposals.map((p) => p.paymentId).filter((id) => credits.has(id))
    : [];
  const ambiguous = previewData
    ? previewData.unresolved.filter((u) => u.reason === 'ambiguous' && credits.has(u.paymentId))
    : [];
  const noUnpaidBookings = previewData
    ? previewData.unresolved.filter((u) => u.reason === 'no-unpaid-bookings')
    : [];
  const otherIssues = previewData
    ? previewData.unresolved.filter(
        (u) => u.reason !== 'ambiguous' && u.reason !== 'no-unpaid-bookings',
      )
    : [];

  const nothingFound =
    previewData !== null &&
    proposalIds.length === 0 &&
    ambiguous.length === 0 &&
    noUnpaidBookings.length === 0 &&
    otherIssues.length === 0;

  return (
    <div className="pb-venmo-import">
      <h3>
        Attribute unattached credits
        <Hint label="Attributing unattached credits">
          A payment recorded against a household — a Venmo import, a spreadsheet import, an adopted
          calendar stay — sometimes isn&rsquo;t tied to any one booking, which leaves the booking
          reading unpaid even though the money is already in. This finds those credits, shows you
          which unpaid booking(s) each one nearest matches, and lets you approve the match before
          anything is recorded.
        </Hint>
      </h3>
      <p className="pb-applies">
        Nothing here is written until you press Apply. Every figure — the payment amount, each
        booking&rsquo;s outstanding balance, the remainder — is read fresh from your records, never
        estimated.
      </p>

      <div className="pb-row">
        <button onClick={() => void runPreview()} disabled={busy}>
          {busy && !previewData ? 'Checking…' : 'Check for unattached credits'}
        </button>
        {previewData && (
          <button onClick={reset} disabled={busy}>
            Start over
          </button>
        )}
      </div>

      {result && (
        <p className="pb-applies" role="status">
          Applied {result.applied} attribution{result.applied === 1 ? '' : 's'}.
          {result.skipped.length > 0
            ? ` ${result.skipped.length} skipped: ${result.skipped.map((s) => s.reason).join('; ')}.`
            : ''}
        </p>
      )}

      {previewData && (
        <>
          {nothingFound && <p className="pb-hint">No unattached credits found.</p>}

          {proposalIds.length > 0 && (
            <>
              <h4>Ready to attribute ({proposalIds.length})</h4>
              <ul>
                {proposalIds.map((id) => {
                  const credit = credits.get(id);
                  if (!credit) return null;
                  return (
                    <CreditEditor
                      key={id}
                      credit={credit}
                      label={label(credit.accountId)}
                      busy={busy}
                      onToggleIncluded={() => toggleIncluded(id)}
                      onToggleRow={(bookingId) => toggleRow(id, bookingId)}
                      onRowAmount={(bookingId, value) => setRowAmount(id, bookingId, value)}
                    />
                  );
                })}
              </ul>
            </>
          )}

          {ambiguous.length > 0 && (
            <>
              <h4>Needs your call — tied bookings ({ambiguous.length})</h4>
              <p className="pb-applies">
                Two or more bookings are an equally good match and the payment doesn&rsquo;t cover
                all of them &mdash; pick which one(s) to attribute it to.
              </p>
              <ul>
                {ambiguous.map((u) => {
                  const credit = credits.get(u.paymentId);
                  if (!credit) return null;
                  return (
                    <li key={u.paymentId}>
                      <p className="pb-hint">{u.detail}</p>
                      <CreditEditor
                        credit={credit}
                        label={label(credit.accountId)}
                        busy={busy}
                        onToggleIncluded={() => toggleIncluded(u.paymentId)}
                        onToggleRow={(bookingId) => toggleRow(u.paymentId, bookingId)}
                        onRowAmount={(bookingId, value) =>
                          setRowAmount(u.paymentId, bookingId, value)
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {noUnpaidBookings.length > 0 && (
            <details className="pb-attribution-inert">
              <summary>
                {noUnpaidBookings.length} credit{noUnpaidBookings.length === 1 ? '' : 's'} with no
                unpaid bookings to attach to
              </summary>
              <ul>
                {noUnpaidBookings.map((u) => (
                  <li key={u.paymentId} className="pb-hint">
                    ${u.amount} from {label(u.accountId)} on {formatFriendlyDate(u.paidDate)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {otherIssues.length > 0 && (
            <details className="pb-attribution-inert">
              <summary>
                {otherIssues.length} credit{otherIssues.length === 1 ? '' : 's'} that need attention
                before they can be attributed
              </summary>
              <ul>
                {otherIssues.map((u) => (
                  <li key={u.paymentId} className="pb-hint">
                    ${u.amount} from {label(u.accountId)} on {formatFriendlyDate(u.paidDate)} —{' '}
                    {u.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(proposalIds.length > 0 || ambiguous.length > 0) && (
            <div className="pb-row">
              <button
                onClick={() => void runApply()}
                disabled={busy || toApply.length === 0 || hasBlockedIncluded}
              >
                {busy
                  ? 'Applying…'
                  : `Apply ${toApply.length} attribution${toApply.length === 1 ? '' : 's'} ($${totalAmount})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
