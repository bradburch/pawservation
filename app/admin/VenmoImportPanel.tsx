import { useState } from 'react';
import { adminApi, type VenmoImportResult, type VenmoPreview } from '../shared-ui/api.js';
import { formatFriendlyDate } from '../../src/shared/index.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/**
 * Upload the CSV Venmo gives you, see what Pawservation thinks each received payment belongs to,
 * fix what it got wrong, and record the lot.
 *
 * The file text lives in this component's state for exactly as long as the sitter is deciding: the
 * confirm request sends it back so the SERVER re-reads every amount and date (the browser posts
 * only which transaction goes on which booking), and both are dropped the moment the import
 * finishes. Nothing about the file is stored anywhere, which is what the copy below promises.
 */
export function VenmoImportPanel({
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
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const [preview, setPreview] = useState<VenmoPreview | null>(null);
  const [choices, setChoices] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VenmoImportResult | null>(null);
  // The server's skip list carries only a txnId + reason. Snapshotted from `preview` right before
  // `record()` calls `reset()` (which nulls `preview` out) so a skipped row can still be shown as
  // "$99 from Jess Demo — reason" instead of a bare txnId-less reason.
  const [chosenInfo, setChosenInfo] = useState<Map<string, { amount: number; from: string }>>(
    new Map(),
  );

  const reset = () => {
    setCsv(null);
    setFileName('');
    setPreview(null);
    setChoices(new Map());
    setFileKey((k) => k + 1);
  };

  const chosen = [...choices.entries()].map(([txnId, bookingId]) => ({ txnId, bookingId }));
  const chosenTotal = preview
    ? chosen.reduce((sum, { txnId }) => {
        const row = [...preview.matched, ...preview.ambiguous].find((r) => r.txnId === txnId);
        return sum + (row?.amount ?? 0);
      }, 0)
    : 0;

  const check = async (file: File) => {
    clearError();
    setResult(null);
    setBusy(true);
    try {
      const text = await file.text();
      const next = await adminApi.payments.venmoPreview(session.slug, session.token, text);
      setCsv(text);
      setPreview(next);
      // Everything Pawservation is sure about starts ticked; ambiguous rows start unticked so the
      // sitter has to make the choice rather than accept a guess.
      setChoices(new Map(next.matched.map((m) => [m.txnId, m.bookingId])));
    } catch (e) {
      reset();
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (txnId: string, bookingId: string) =>
    setChoices((prev) => {
      const next = new Map(prev);
      if (next.get(txnId) === bookingId) next.delete(txnId);
      else next.set(txnId, bookingId);
      return next;
    });

  const record = async () => {
    if (!csv || chosen.length === 0 || busy) return;
    clearError();
    setBusy(true);
    try {
      // Capture amount + sender for every chosen txn BEFORE reset() clears `preview` — this is
      // the only place left that still knows what a skipped txnId was.
      const rows = preview ? [...preview.matched, ...preview.ambiguous] : [];
      setChosenInfo(
        new Map(
          chosen.flatMap(({ txnId }) => {
            const row = rows.find((r) => r.txnId === txnId);
            return row ? [[txnId, { amount: row.amount, from: row.clientLabel }] as const] : [];
          }),
        ),
      );
      setResult(await adminApi.payments.venmoImport(session.slug, session.token, csv, chosen));
      reset();
      await onImported();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-venmo-import">
      <h3>
        Import from Venmo
        <Hint label="Importing from Venmo">
          Download your transaction CSV from Venmo and upload it here. Pawservation reads the
          payments that came in, works out which client sent each one, and shows you everything
          before a single payment is recorded.
        </Hint>
      </h3>
      <p className="pb-applies">
        Files are checked and read in memory &mdash; we never store them. Payments are matched to
        clients by the Venmo name they came from. If a client pays under a handle that isn&rsquo;t
        their name, put it on their row in Clients (&ldquo;Venmo username (if different from their
        name)&rdquo;) and check the file again.
      </p>

      <div className="pb-row">
        <input
          key={fileKey}
          type="file"
          accept=".csv"
          aria-label="Venmo CSV"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setFileName(file?.name ?? '');
            if (file) void check(file);
          }}
        />
        {busy && <span className="pb-hint">Working&hellip;</span>}
        {preview && (
          <button onClick={reset} disabled={busy}>
            Start over
          </button>
        )}
      </div>

      {result && (
        <p className="pb-applies" role="status">
          Recorded {result.imported} payment{result.imported === 1 ? '' : 's'} totalling $
          {result.totalAmount}.
          {result.skipped.length > 0
            ? ` ${result.skipped.length} skipped: ${result.skipped
                .map((s) => {
                  const info = chosenInfo.get(s.txnId);
                  return info ? `$${info.amount} from ${info.from} — ${s.reason}` : s.reason;
                })
                .join('; ')}.`
            : ''}
        </p>
      )}

      {preview && (
        <>
          {preview.matched.length + preview.ambiguous.length === 0 && (
            <p className="pb-hint">
              Nothing in {fileName} needs recording &mdash; see below for why.
            </p>
          )}

          {preview.matched.length > 0 && (
            <>
              <h4>Ready to record</h4>
              <ul>
                {preview.matched.map((m) => (
                  <li key={m.txnId}>
                    <label className="pb-inline">
                      <input
                        type="checkbox"
                        checked={choices.get(m.txnId) === m.bookingId}
                        onChange={() => toggle(m.txnId, m.bookingId)}
                      />{' '}
                      ${m.amount} from {m.clientLabel} on {formatFriendlyDate(m.date)} &rarr;{' '}
                      {m.bookingLabel}
                      {m.note ? ` — “${m.note}”` : ''}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          {preview.ambiguous.length > 0 && (
            <>
              <h4>Which booking?</h4>
              <ul>
                {preview.ambiguous.map((a) => (
                  <li key={a.txnId}>
                    ${a.amount} from {a.clientLabel} on {formatFriendlyDate(a.date)}
                    {a.note ? ` — “${a.note}”` : ''}
                    <select
                      value={choices.get(a.txnId) ?? ''}
                      aria-label={`Booking for the $${a.amount} payment from ${a.clientLabel}`}
                      onChange={(e) =>
                        setChoices((prev) => {
                          const next = new Map(prev);
                          if (e.target.value === '') next.delete(a.txnId);
                          else next.set(a.txnId, e.target.value);
                          return next;
                        })
                      }
                    >
                      <option value="">Don&rsquo;t record this one</option>
                      {a.candidates.map((candidate) => (
                        <option key={candidate.bookingId} value={candidate.bookingId}>
                          {candidate.label} (${candidate.balance} owing)
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </>
          )}

          {preview.unmatched.length > 0 && (
            <>
              <h4>Couldn&rsquo;t place these</h4>
              <ul>
                {preview.unmatched.map((u) => (
                  <li key={u.txnId} className="pb-hint">
                    ${u.amount} from {u.from || 'an unnamed sender'} on {formatFriendlyDate(u.date)}{' '}
                    &mdash; {u.reason}
                  </li>
                ))}
              </ul>
            </>
          )}

          {preview.problems.length > 0 && (
            <ul>
              {preview.problems.map((p) => (
                <li key={p.row} className="pb-hint">
                  Row {p.row}: {p.reason}
                </li>
              ))}
            </ul>
          )}

          <p className="pb-hint">
            {preview.alreadyImported.length > 0
              ? `${preview.alreadyImported.length} ${preview.alreadyImported.length === 1 ? 'payment' : 'payments'} in this file ${preview.alreadyImported.length === 1 ? 'was' : 'were'} imported before and ${preview.alreadyImported.length === 1 ? 'is' : 'are'} left alone. `
              : ''}
            {preview.ignored > 0
              ? `${preview.ignored} ${preview.ignored === 1 ? "row wasn't a" : "rows weren't"} client payment${preview.ignored === 1 ? '' : 's'} coming in (bank transfers, pending or cancelled) and ${preview.ignored === 1 ? 'was' : 'were'} skipped.`
              : ''}
          </p>

          <div className="pb-row">
            <button onClick={() => void record()} disabled={busy || chosen.length === 0}>
              {busy
                ? 'Recording…'
                : `Record ${chosen.length} payment${chosen.length === 1 ? '' : 's'} ($${chosenTotal})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
