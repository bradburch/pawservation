import { useEffect, useState } from 'react';
import { isValidRate } from '../../src/shared/index.js';
import { adminApi, type BookingCharge } from '../shared-ui/api.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

const MAX_LABEL = 60;

/**
 * One booking's extra charges — the things that happened after the quote (a vet run, a bath).
 * Deliberately separate from the payment ledger next to it: a charge is money OWED, a payment is
 * money RECEIVED. Adding one never changes the booking's estimated cost; the row's balance is
 * recomputed from estCost + charges by `totalDue`.
 */
export function ChargesPanel({
  session,
  bookingId,
  onChanged,
  handleError,
  allowAdd = true,
}: {
  session: Session;
  bookingId: string;
  onChanged: () => void | Promise<void>;
  handleError: (e: unknown) => void;
  /** False for cancelled/declined bookings: existing charges stay visible, but no new ones. */
  allowAdd?: boolean;
}) {
  const [charges, setCharges] = useState<BookingCharge[] | null>(null);
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const ADDING = '__add__';

  const amountNum = Number(amount);
  // Same predicates the server enforces — UX only; the server validates independently.
  const canSubmit =
    label.trim() !== '' && label.trim().length <= MAX_LABEL && isValidRate(amountNum);

  const load = () =>
    adminApi.charges.list(session.slug, session.token, bookingId).then(({ charges: l }) => l);

  useEffect(() => {
    let active = true;
    load()
      .then((l) => active && setCharges(l))
      .catch((e) => active && handleError(e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, session]);

  const add = async () => {
    if (busyId) return;
    setBusyId(ADDING);
    try {
      await adminApi.charges.add(session.slug, session.token, bookingId, {
        label: label.trim(),
        amount: amountNum,
      });
      setLabel('');
      setAmount('');
      setCharges(await load());
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (chargeId: string) => {
    if (busyId) return;
    setBusyId(chargeId);
    try {
      await adminApi.charges.remove(session.slug, session.token, bookingId, chargeId);
      setCharges(await load());
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  if (!allowAdd && charges !== null && charges.length === 0) return null;

  return (
    <div className="pb-charges">
      <h4>
        Extra charges
        <Hint label="Extra charges">
          Something that came up after you agreed the price — a vet visit, a bath, extra food. It is
          added to what this client owes; the original estimate stays exactly as it was quoted.
        </Hint>
      </h4>
      {charges === null ? (
        <p>Loading…</p>
      ) : charges.length === 0 ? (
        allowAdd && <p className="pb-hint">No extra charges.</p>
      ) : (
        <ul>
          {charges.map((ch) => (
            <li key={ch.id}>
              <span>
                {ch.label} · ${ch.amount}
              </span>
              <button disabled={busyId === ch.id} onClick={() => void remove(ch.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {allowAdd && (
        <div className="pb-row">
          <label className="pb-inline">
            Add charge
            <input
              maxLength={MAX_LABEL}
              placeholder="e.g. vet visit, haircut"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="pb-inline">
            Amount ($)
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-invalid={amount !== '' && !isValidRate(amountNum)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <button disabled={busyId === ADDING || !canSubmit} onClick={() => void add()}>
            Add charge
          </button>
        </div>
      )}
    </div>
  );
}
