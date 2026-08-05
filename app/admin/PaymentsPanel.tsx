import { useEffect, useState } from 'react';
import { isValidRate } from '../../src/shared/index.js';
import { adminApi, PAYMENT_METHODS, type Payment } from '../shared-ui/api.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/** Local 'YYYY-MM-DD' default for the paid-date field (the sitter can change it). */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * WHAT this ledger belongs to: one booking, or one HOUSEHOLD (0011). Exactly one — the same
 * either/or the `Payments` row itself is under, expressed as a union so a caller cannot pass both
 * and no code here has to decide which wins.
 */
export type PaymentTarget = { bookingId: string } | { accountId: string };

/**
 * A payment ledger: existing payments (each deletable — deleting the record is the only correction
 * mechanism) plus the record-payment form. Shared by BookingsSection (booking rows), EarningsSection
 * (outstanding bookings) and EarningsSection's household balances; `onChanged` lets each parent
 * re-fetch its own payload.
 *
 * The two targets differ ONLY in which endpoints these three calls hit. Everything the sitter sees
 * and types — the amount rule, the method list, the date default, the confirm before a delete — is
 * deliberately identical, because "record what you were paid" is one habit and a form that changed
 * shape depending on what she clicked would be two.
 */
export function PaymentsPanel({
  session,
  target,
  onChanged,
  handleError,
  allowRecord = true,
}: {
  session: Session;
  target: PaymentTarget;
  onChanged: () => void | Promise<void>;
  handleError: (e: unknown) => void;
  /** False for cancelled/declined bookings: the ledger is read-only (delete is the refund-
   * correction mechanism), so the record-payment form is hidden. */
  allowRecord?: boolean;
}) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('cash');
  const [paidDate, setPaidDate] = useState(todayStr);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const RECORDING = '__record__';

  const amountNum = Number(amount);
  // Same predicate the server enforces on POST payments (server/lib/validation.ts re-exports it)
  // — this copy is UX only; the server still validates independently.
  const canSubmit = isValidRate(amountNum) && paidDate.trim() !== '';

  // One key for the effect below and one branch for the three calls: 'bookingId' in target is the
  // only place this component asks which kind of ledger it is showing.
  const targetId = 'bookingId' in target ? target.bookingId : target.accountId;

  const load = () =>
    ('bookingId' in target
      ? adminApi.payments.list(session.slug, session.token, target.bookingId)
      : adminApi.payments.listForAccount(session.slug, session.token, target.accountId)
    ).then(({ payments: list }) => list);

  useEffect(() => {
    let active = true;
    load()
      .then((list) => active && setPayments(list))
      .catch((e) => active && handleError(e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, session]);

  const record = async () => {
    if (busyId) return;
    setBusyId(RECORDING);
    try {
      const body = {
        amount: amountNum,
        method,
        paidDate,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      if ('bookingId' in target) {
        await adminApi.payments.record(session.slug, session.token, target.bookingId, body);
      } else {
        await adminApi.payments.recordForAccount(
          session.slug,
          session.token,
          target.accountId,
          body,
        );
      }
      setAmount('');
      setNote('');
      setPaidDate(todayStr());
      setPayments(await load());
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (paymentId: string) => {
    if (busyId) return;
    // Money rows get a confirm — same rule as cancel-with-fee in BookingsSection.
    const p = payments?.find((row) => row.id === paymentId);
    const what = p ? `the $${p.amount} payment` : 'this payment';
    if (!window.confirm(`Delete ${what}? This changes what the client owes.`)) return;
    setBusyId(paymentId);
    try {
      if ('bookingId' in target) {
        await adminApi.payments.remove(session.slug, session.token, target.bookingId, paymentId);
      } else {
        await adminApi.payments.removeForAccount(
          session.slug,
          session.token,
          target.accountId,
          paymentId,
        );
      }
      setPayments(await load());
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  if (!allowRecord && payments !== null && payments.length === 0) return null;

  return (
    <div className="pb-payments">
      {payments === null ? (
        <p>Loading…</p>
      ) : payments.length === 0 ? (
        allowRecord && <p className="pb-hint">No payments recorded yet.</p>
      ) : (
        <ul>
          {payments.map((p) => (
            <li key={p.id}>
              <span>
                ${p.amount} · {p.method} · {p.paidDate}
                {p.note ? ` — ${p.note}` : ''}
              </span>
              <button
                disabled={busyId === p.id}
                onClick={() => void remove(p.id)}
                aria-label={`Delete the $${p.amount} ${p.method} payment`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {allowRecord && (
        <div className="pb-row">
          <label className="pb-inline">
            Amount ($)
            <input
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="pb-inline">
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="pb-inline">
            Date
            <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
          </label>
          <label className="pb-inline">
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button disabled={busyId === RECORDING || !canSubmit} onClick={() => void record()}>
            Record payment
          </button>
          <Hint label="Recording payments">
            Pawservation doesn&rsquo;t take payments — you collect money however you like (cash,
            Venmo, Zelle…). Record what you received here so Earnings stays right; deposits and
            partial payments are fine.
          </Hint>
        </div>
      )}
    </div>
  );
}
