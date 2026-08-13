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
import {
  balancedRemainder,
  formatFriendlyDate,
  MAX_ATTRIBUTIONS_PER_REQUEST,
} from '../../src/shared/index.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/** Whole dollars only, at least $1 — same idiom as CalendarBackfillPanel's `isWholeDollar`. This
 *  is UX only; the server independently validates every split and refuses a bad one. */
function isWholeDollar(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

/**
 * How many attributions one Apply request carries. The apply route refuses more than this
 * (MAX_ATTRIBUTIONS_PER_REQUEST, src/shared/invoicing/attribution-splits.ts, where the
 * subrequest arithmetic behind the number is spelled out), so a set larger than it goes in
 * successive requests — the SAME constant the server enforces, exactly as
 * `CalendarBackfillPanel`'s `IMPORT_CHUNK_SIZE` shares `MAX_BACKFILL_EVENTS`, so the two can
 * never drift into a flat 400 the sitter cannot act on.
 *
 * The sitter still clicks Apply ONCE. The live account this was built for has 47 actionable
 * credits and a ceiling of 6 per request; telling her to tick six at a time, eight times over,
 * would be the platform's budget pushed onto the person least able to do anything about it (the
 * same call PR #124 made for the calendar backfill's date range).
 */
const APPLY_CHUNK_SIZE = MAX_ATTRIBUTIONS_PER_REQUEST;

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
  /** The server's OWN remainder for this credit as proposed (`AttributionProposal.remainder`) —
   *  shown verbatim until the sitter changes a row, rather than recomputed from scratch for a
   *  state that hasn't moved. `null` for an ambiguous credit: the server proposed nothing for it
   *  at all, so there is no server figure to prefer over the live derivation. */
  serverRemainder: number | null;
  /** A snapshot of `rows` at construction (bookingId/checked/amountText only), so `isUnedited`
   *  below can tell "still exactly what the server proposed" from "the sitter touched this." */
  originalRows: { bookingId: string; checked: boolean; amountText: string }[];
};

function snapshotRows(rows: Row[]): EditableCredit['originalRows'] {
  return rows.map((r) => ({
    bookingId: r.bookingId,
    checked: r.checked,
    amountText: r.amountText,
  }));
}

/** True while `credit.rows` still matches `credit.originalRows` exactly — the sitter hasn't
 *  touched a checkbox or an amount on this credit since it was built from the preview response. */
function isUnedited(credit: EditableCredit): boolean {
  return (
    credit.rows.length === credit.originalRows.length &&
    credit.rows.every((r, i) => {
      const o = credit.originalRows[i];
      return (
        o.bookingId === r.bookingId && o.checked === r.checked && o.amountText === r.amountText
      );
    })
  );
}

function fromProposal(p: AttributionProposal): EditableCredit {
  const rows = p.splits.map((s) => ({ ...s, checked: true, amountText: String(s.amount) }));
  return {
    paymentId: p.paymentId,
    accountId: p.accountId,
    amount: p.amount,
    paidDate: p.paidDate,
    rows,
    // A proposal can legitimately carry NO splits — an unaffordable tie the credit couldn't have
    // reached anyway is not something `proposeAttribution` refuses, it just leaves the whole
    // amount as remainder (see its own doc comment). There is nothing to check in that case, so
    // it starts un-included: ticking it would only submit an empty, server-refused attribution.
    included: p.splits.length > 0,
    serverRemainder: p.remainder,
    originalRows: snapshotRows(rows),
  };
}

function fromAmbiguous(u: AttributionUnresolved): EditableCredit {
  const rows = u.bookings.map((b) => ({ ...b, checked: false, amountText: '' }));
  return {
    paymentId: u.paymentId,
    accountId: u.accountId,
    amount: u.amount,
    paidDate: u.paidDate,
    rows,
    included: false,
    // The server never proposed a split for an ambiguous credit — there is no figure to prefer,
    // so this always falls through to the live derivation in `remainderFor`.
    serverRemainder: null,
    originalRows: snapshotRows(rows),
  };
}

/**
 * The client-side mirror of `proposeAttribution`'s conservation rule
 * (`balancedRemainder`, src/shared/invoicing/attribution-splits.ts) applied to what the sitter
 * currently has checked and typed for one credit — extended with the one check that rule can't
 * make on its own: a checked row's amount must not exceed THAT booking's own outstanding (also
 * shown on the row), the same live-outstanding refusal `applyAttribution` would otherwise hand
 * back after a round trip (server/db/repo.ts). `null` means "not submittable yet" — an unusable
 * amount on a checked row, a split bigger than its booking's outstanding, or a total that
 * overshoots the credit — which is exactly what blocks Apply and shows the inline message, before
 * the server ever sees it.
 */
function remainderFor(credit: EditableCredit): number | null {
  const checked = credit.rows.filter((r) => r.checked);
  for (const r of checked) {
    if (!isWholeDollar(r.amountText)) return null;
    if (Number(r.amountText) > r.outstanding) return null;
  }
  return balancedRemainder(
    credit.amount,
    checked.map((r) => ({ amount: Number(r.amountText) })),
  );
}

/**
 * Why `remainderFor` refused, in words — split out so the inline message names the actual
 * problem instead of one generic "doesn't add up" for three different causes: a blank or
 * fractional amount, a split bigger than what's outstanding on that booking, or a total that
 * overshoots the credit. Only called once `remainderFor` has already returned `null`.
 */
function creditIssue(credit: EditableCredit): string {
  const checked = credit.rows.filter((r) => r.checked);
  const blank = checked.find((r) => !isWholeDollar(r.amountText));
  if (blank) return `Type a whole-dollar amount of $1 or more for ${blank.serviceType}.`;
  const overOutstanding = checked.find((r) => Number(r.amountText) > r.outstanding);
  if (overOutstanding)
    return `$${overOutstanding.amountText} is more than the $${overOutstanding.outstanding} outstanding on ${overOutstanding.serviceType}.`;
  const sum = checked.reduce((s, r) => s + Number(r.amountText), 0);
  return `These splits add up to $${sum}, more than the $${credit.amount} payment.`;
}

/** One credit's editable block — the split rows plus the master include tick, shared by the
 *  "ready to attribute" and "needs your call" sections below (they differ only in starting state
 *  and surrounding copy, never in how a row is edited). */
function CreditEditor({
  credit,
  label,
  detail,
  busy,
  onToggleIncluded,
  onToggleRow,
  onRowAmount,
}: {
  credit: EditableCredit;
  label: string;
  /** The server's own explanation for why this credit needed a decision at all (only set for an
   *  `ambiguous` credit) — rendered inside this one `<li>` rather than a wrapping element the
   *  caller adds, which used to nest a second `<li>` with nothing between it and this one. */
  detail?: string;
  busy: boolean;
  onToggleIncluded: () => void;
  onToggleRow: (bookingId: string) => void;
  onRowAmount: (bookingId: string, value: string) => void;
}) {
  const remainder = remainderFor(credit);
  // The server's own remainder, shown verbatim while nothing has moved since the preview — the
  // moment the sitter touches a row it's necessarily stale and the live derivation takes over.
  const displayRemainder =
    remainder !== null && credit.serverRemainder !== null && isUnedited(credit)
      ? credit.serverRemainder
      : remainder;
  const anyChecked = credit.rows.some((r) => r.checked);
  return (
    <li>
      <label className="pb-inline">
        <input
          type="checkbox"
          checked={credit.included}
          disabled={busy}
          onChange={onToggleIncluded}
        />{' '}
        <strong>${credit.amount}</strong> from {label} on {formatFriendlyDate(credit.paidDate)}
      </label>
      {detail && <p className="pb-hint">{detail}</p>}
      {credit.rows.length === 0 ? (
        <>
          <p className="pb-hint">
            Nothing to attach this to yet — ${credit.amount} would stay as account credit.
          </p>
          {credit.included && (
            <p className="pb-error">
              There&rsquo;s nothing to check here — untick this credit to exclude it from Apply.
            </p>
          )}
        </>
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
                    max={r.outstanding}
                    value={r.amountText}
                    disabled={busy || !r.checked}
                    onChange={(e) => onRowAmount(r.bookingId, e.target.value)}
                    aria-label={`Amount for ${r.serviceType} on ${r.startDate}`}
                  />
                </label>
              </li>
            ))}
          </ul>
          {credit.included && !anyChecked && (
            <p className="pb-error">
              Nothing is checked above &mdash; tick a booking, or untick this credit to exclude it
              from Apply.
            </p>
          )}
          {anyChecked &&
            (remainder === null ? (
              <p className="pb-error">{creditIssue(credit)}</p>
            ) : (
              <p className="pb-hint">${displayRemainder} would stay as account credit.</p>
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
  // Progress text for a chunked Apply ("Applying — 12 of 47…"), shown in the button itself the way
  // CalendarBackfillPanel shows its own. Null whenever one request covers the whole set.
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [result, setResult] = useState<AttributionApplyResult | null>(null);
  /**
   * What a failed chunked run got through, shown ALONGSIDE the server's own error rather than
   * instead of it.
   *
   * The failure itself goes to `handleError` UNWRAPPED, and that is load-bearing: `App.tsx`'s
   * `handle` signs the sitter out on a 401/403 `ApiError` and routes a disabled account by
   * `e.message === 'account_disabled'` — both `instanceof` checks, so both only work while the
   * error is still an `ApiError`. (Not `e.code`: that is undefined on this route.) Rewrapping the
   * progress and the failure into one `new Error` threw the server's own message away, which for
   * an expired mid-run token left the sitter re-pressing Apply forever, never told to sign in.
   */
  const [failureNote, setFailureNote] = useState<string | null>(null);
  // Snapshotted from `credits` at the moment `runApply` fires (CsvImportPanel's `chosenInfo`
  // idiom) — a `skipped` reason only names a `paymentId`, and by the time it's rendered a later
  // preview may have already rebuilt `credits` without that entry, or removed a since-applied one
  // it briefly shared an id namespace with. This is the only place left that still knows which
  // household and amount a given skipped id was.
  const [resultInfo, setResultInfo] = useState<Map<string, { amount: number; label: string }>>(
    new Map(),
  );

  const label = (accountId: string) => households?.get(accountId) ?? accountId;

  const reset = () => {
    setPreviewData(null);
    setCredits(new Map());
    setResult(null);
    setResultInfo(new Map());
    setFailureNote(null);
  };

  const runPreview = async () => {
    if (busy) return;
    clearError();
    setResult(null);
    // Cleared with `result`, for the same reason and against the same staleness: a fresh preview
    // is a fresh run, and a note about what the LAST Apply got through would read as if it were
    // about the list now on screen.
    setFailureNote(null);
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

  /**
   * Apply everything the sitter approved, in chunks of APPLY_CHUNK_SIZE, on one click.
   *
   * `applied` and `skipped` ACCUMULATE across chunks and land in one `result` — the sitter
   * approved one set and is owed one answer about it, with every server `reason` still verbatim.
   * `result` is updated after each chunk rather than only at the end, so a long run shows its own
   * progress and a failure partway through still leaves the earlier chunks' outcome on screen:
   * those are real, committed writes on the server, not something a client-side rollback could or
   * should undo (`CalendarBackfillPanel.runImport`'s posture, same reasoning).
   */
  const runApply = async () => {
    if (busy || toApply.length === 0 || hasBlockedIncluded) return;
    clearError();
    // Cleared BEFORE the run, not merely overwritten after the first chunk succeeds: a run whose
    // very first chunk throws would otherwise leave the PREVIOUS run's "Applied 5 attributions"
    // banner sitting under a fresh error that says "what succeeded is already reflected above."
    setResult(null);
    setFailureNote(null);
    setBusy(true);
    // Snapshotted BEFORE the removals below touch `credits` — every id in `toApply` is still in
    // the map at this point, applied or skipped alike.
    setResultInfo(
      new Map(
        toApply.map((a) => {
          const credit = credits.get(a.paymentId)!;
          return [a.paymentId, { amount: credit.amount, label: label(credit.accountId) }] as const;
        }),
      ),
    );
    const chunked = toApply.length > APPLY_CHUNK_SIZE;
    if (chunked) setApplyStatus(`Applying — 0 of ${toApply.length}…`);

    let applied = 0;
    const skipped: AttributionApplyResult['skipped'] = [];
    const appliedIds = new Set<string>();
    let failure: unknown = null;
    for (let i = 0; i < toApply.length; i += APPLY_CHUNK_SIZE) {
      const chunk = toApply.slice(i, i + APPLY_CHUNK_SIZE);
      try {
        const outcome = await adminApi.payments.attributeApply(session.slug, session.token, chunk);
        applied += outcome.applied;
        skipped.push(...outcome.skipped);
        const skippedIds = new Set(outcome.skipped.map((s) => s.paymentId));
        for (const a of chunk) if (!skippedIds.has(a.paymentId)) appliedIds.add(a.paymentId);
        setResult({ applied, skipped: [...skipped] });
        if (chunked) setApplyStatus(`Applying — ${i + chunk.length} of ${toApply.length}…`);
      } catch (e) {
        failure = e;
        // THREE OUTCOMES, NOT TWO. The chunk that threw WAS SENT, so its fate is genuinely
        // unknown — the request can fail after the server committed every write in it (a dropped
        // connection on the response). Counting it with the ones that were never sent would tell
        // the sitter that money which may well have moved was "not attempted", and then hand her
        // the refusals to prove it when she re-applies. Only what comes AFTER the in-flight chunk
        // was truly never attempted.
        setFailureNote(
          // Skipped ones are named too, or the three counts read like they should sum to the
          // total and quietly don't — the server can refuse a credit inside a chunk that
          // otherwise succeeded, and those live in the result banner above, not here.
          `${applied} of the ${toApply.length} you approved ${applied === 1 ? 'was' : 'were'} applied` +
            (skipped.length > 0
              ? ` and ${skipped.length} ${skipped.length === 1 ? 'was' : 'were'} refused (listed above). `
              : '. ') +
            `${chunk.length} ${chunk.length === 1 ? 'was' : 'were'} sent without an answer coming back, so ${chunk.length === 1 ? 'it may or may not have' : 'they may or may not have'} been recorded; ` +
            `${toApply.length - i - chunk.length} ${toApply.length - i - chunk.length === 1 ? 'was' : 'were'} not attempted. ` +
            // Deliberately does NOT promise the words the refusal will use. Re-applying an
            // already-recorded credit refuses with "… is not a household-level payment of account
            // …" (repo.ts), because the source row is gone — accurate, but it reads like a
            // wrong-account error to anyone told to expect "already attributed".
            'Press Apply again to pick up the rest. Nothing can be applied twice: a credit that was already recorded comes back as a refusal rather than a second payment, whatever wording it uses.',
        );
        break;
      }
    }

    setApplyStatus(null);
    setBusy(false);
    // Exactly the credits the server confirmed it applied leave the list — never the whole chunk,
    // and never the ones a later chunk never reached. A skipped credit stays on screen with its
    // reason beside it, which is the only way the sitter can act on it.
    if (appliedIds.size > 0)
      setCredits((prev) => {
        const next = new Map(prev);
        for (const id of appliedIds) next.delete(id);
        return next;
      });
    if (appliedIds.size > 0 || !failure) await onApplied();

    // The failure itself, untouched — see `failureNote` above for why it is never rewrapped.
    if (failure) handleError(failure);
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
            ? ` ${result.skipped.length} skipped: ${result.skipped
                .map((s) => {
                  // The server's own `reason` is shown VERBATIM and already ends in a period —
                  // no separator/trailing punctuation is added around it, just an identifying
                  // prefix so a sitter with dozens of skips can tell which credit each is about.
                  const info = resultInfo.get(s.paymentId);
                  return info ? `$${info.amount} from ${info.label} — ${s.reason}` : s.reason;
                })
                .join(' ')}`
            : ''}
        </p>
      )}

      {/* `status`, not `alert` as every other `pb-error` here uses: this is progress information
          that always fires alongside App's own `role="alert"` banner, and two simultaneous
          assertive announcements talk over each other. */}
      {failureNote && (
        <p className="pb-error" role="status">
          {failureNote}
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
                    <CreditEditor
                      key={u.paymentId}
                      credit={credit}
                      label={label(credit.accountId)}
                      detail={u.detail}
                      busy={busy}
                      onToggleIncluded={() => toggleIncluded(u.paymentId)}
                      onToggleRow={(bookingId) => toggleRow(u.paymentId, bookingId)}
                      onRowAmount={(bookingId, value) =>
                        setRowAmount(u.paymentId, bookingId, value)
                      }
                    />
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
                  ? (applyStatus ?? 'Applying…')
                  : // No dollar figure here on purpose — a credit's face value isn't what lands
                    // on a booking (a $600 credit can have a $40 split and a $560 remainder), and
                    // there is no server total for "amount attributed" to substitute instead.
                    // Each credit's own remainder line above already says what stays as account
                    // credit; summing face values here would be exactly the client-side money
                    // EarningsSection's own invariant forbids ("nothing on this page adds up a
                    // household").
                    `Apply ${toApply.length} attribution${toApply.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
