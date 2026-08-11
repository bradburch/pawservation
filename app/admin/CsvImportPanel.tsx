import { useState } from 'react';
import {
  adminApi,
  PAYMENT_METHODS,
  type CsvColumnMapping,
  type CsvImportResult,
  type CsvPreview,
  type CsvShape,
} from '../shared-ui/api.js';
import { formatFriendlyDate, type PaymentMethod } from '../../src/shared/index.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/** One target field the sitter maps onto a column of their own file. Date/Amount/Payer are
 *  required before Preview enables; the rest are optional. */
type MappingField = 'date' | 'amount' | 'payer' | 'method' | 'reference' | 'note';
const REQUIRED_FIELDS: MappingField[] = ['date', 'amount', 'payer'];
const OPTIONAL_FIELDS: MappingField[] = ['method', 'reference', 'note'];
const FIELD_LABELS: Record<MappingField, string> = {
  date: 'Date',
  amount: 'Amount',
  payer: 'Paid by',
  method: 'Method',
  reference: 'Reference',
  note: 'Note',
};
const EMPTY_MAPPING: Record<MappingField, string> = {
  date: '',
  amount: '',
  payer: '',
  method: '',
  reference: '',
  note: '',
};

/**
 * Upload any payment CSV — a bank export, PayPal, Zelle, whatever the sitter's own spreadsheet
 * looks like — map its own columns onto Date/Amount/Paid-by (plus optional Method/Reference/Note),
 * see what Pawservation thinks each payment belongs to, fix what it got wrong, and record the lot.
 * The free-form sibling of `VenmoImportPanel`, for a sitter whose bank or payment app doesn't
 * export Venmo's fixed shape — same contract, one extra step up front.
 *
 * The file text lives in this component's state for exactly as long as the sitter is deciding: the
 * confirm request sends it back, plus the mapping and default method, so the SERVER re-reads every
 * amount, date and column (the browser posts only which row goes on which household), and all of it
 * is dropped the moment the import finishes. Nothing about the file is stored anywhere, which is
 * what the copy below promises.
 */
export function CsvImportPanel({
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
  const [columns, setColumns] = useState<CsvShape | null>(null);
  // Column index chosen for each field, as a <select>'s string value ('' = unset). Turned into
  // CsvColumnMapping's numeric indices only when building a request (see `mapping` below).
  const [mapped, setMapped] = useState<Record<MappingField, string>>(EMPTY_MAPPING);
  const [defaultMethod, setDefaultMethod] = useState<PaymentMethod>('cash');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [choices, setChoices] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  // The server's skip list carries only a dedupeKey + reason. Snapshotted from `preview` right
  // before `record()` calls `reset()` (which nulls `preview` out) so a skipped row can still be
  // shown as "$99 from Jess Demo — reason" instead of a bare dedupeKey-less reason.
  const [chosenInfo, setChosenInfo] = useState<Map<string, { amount: number; payer: string }>>(
    new Map(),
  );

  const reset = () => {
    setCsv(null);
    setFileName('');
    setColumns(null);
    setMapped(EMPTY_MAPPING);
    setPreview(null);
    setChoices(new Map());
    setFileKey((k) => k + 1);
  };

  const chosen = [...choices.entries()].map(([dedupeKey, accountId]) => ({
    dedupeKey,
    accountId,
  }));
  const chosenTotal = preview
    ? chosen.reduce((sum, { dedupeKey }) => {
        const row = preview.matched.find((r) => r.dedupeKey === dedupeKey);
        return sum + (row?.amount ?? 0);
      }, 0)
    : 0;

  // Date, Amount and Paid-by must all be chosen before there's anything to preview; the optional
  // three ride along only when the sitter picked a column for them.
  const mapping: CsvColumnMapping | null =
    mapped.date !== '' && mapped.amount !== '' && mapped.payer !== ''
      ? {
          date: Number(mapped.date),
          amount: Number(mapped.amount),
          payer: Number(mapped.payer),
          ...(mapped.method !== '' ? { method: Number(mapped.method) } : {}),
          ...(mapped.reference !== '' ? { reference: Number(mapped.reference) } : {}),
          ...(mapped.note !== '' ? { note: Number(mapped.note) } : {}),
        }
      : null;

  const readFile = async (file: File) => {
    clearError();
    setResult(null);
    setBusy(true);
    try {
      const text = await file.text();
      const shape = await adminApi.payments.csvColumns(session.slug, session.token, text);
      setCsv(text);
      setColumns(shape);
      setMapped(EMPTY_MAPPING);
    } catch (e) {
      reset();
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!csv || !mapping || busy) return;
    clearError();
    setBusy(true);
    try {
      const next = await adminApi.payments.csvPreview(
        session.slug,
        session.token,
        csv,
        mapping,
        defaultMethod,
      );
      setPreview(next);
      // A matched row already names ONE household unambiguously — there is nothing left for the
      // sitter to choose, so every matched row starts ticked (same idiom as VenmoImportPanel).
      setChoices(new Map(next.matched.map((m) => [m.dedupeKey, m.accountId])));
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (dedupeKey: string, accountId: string) =>
    setChoices((prev) => {
      const next = new Map(prev);
      if (next.get(dedupeKey) === accountId) next.delete(dedupeKey);
      else next.set(dedupeKey, accountId);
      return next;
    });

  const record = async () => {
    if (!csv || !mapping || chosen.length === 0 || busy) return;
    clearError();
    setBusy(true);
    try {
      // Capture amount + payer for every chosen row BEFORE reset() clears `preview` — this is the
      // only place left that still knows what a skipped dedupeKey was.
      const rows = preview ? preview.matched : [];
      setChosenInfo(
        new Map(
          chosen.flatMap(({ dedupeKey }) => {
            const row = rows.find((r) => r.dedupeKey === dedupeKey);
            return row
              ? [[dedupeKey, { amount: row.amount, payer: row.clientLabel }] as const]
              : [];
          }),
        ),
      );
      setResult(
        await adminApi.payments.csvImport(
          session.slug,
          session.token,
          csv,
          mapping,
          defaultMethod,
          chosen,
        ),
      );
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
        Import from a spreadsheet
        <Hint label="Importing from a spreadsheet">
          Upload any CSV export from your bank or payment app and tell Pawservation which column is
          which. It reads the payments that came in, works out which client sent each one, and shows
          you everything before a single payment is recorded.
        </Hint>
      </h3>
      <p className="pb-applies">
        Files are checked and read in memory &mdash; we never store them. Payments are matched to
        clients by the name in your &ldquo;Paid by&rdquo; column. If a client pays under a name that
        isn&rsquo;t theirs, put it on their row in Clients (&ldquo;Venmo username (if different from
        their name)&rdquo;) and check the file again.
      </p>

      <div className="pb-row">
        <input
          key={fileKey}
          type="file"
          accept=".csv"
          aria-label="Payment CSV"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setFileName(file?.name ?? '');
            if (file) void readFile(file);
          }}
        />
        <label className="pb-inline">
          Default method
          <select
            value={defaultMethod}
            onChange={(e) => setDefaultMethod(e.target.value as PaymentMethod)}
            disabled={busy}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {busy && <span className="pb-hint">Working&hellip;</span>}
        {columns && (
          <button onClick={reset} disabled={busy}>
            Start over
          </button>
        )}
      </div>

      {columns && (
        <>
          <h4>Columns found in {fileName}</h4>
          <div className="pb-table-wrap">
            <table className="pb-clients-table">
              <thead>
                <tr>
                  {columns.headers.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {columns.sample.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>Which column is which?</h4>
          <p className="pb-applies">Date, Amount and Paid by are required.</p>
          <div className="pb-row">
            {[...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].map((field) => (
              <label className="pb-inline" key={field}>
                {FIELD_LABELS[field]}
                <select
                  value={mapped[field]}
                  onChange={(e) => setMapped((prev) => ({ ...prev, [field]: e.target.value }))}
                  disabled={busy}
                >
                  <option value="">
                    {OPTIONAL_FIELDS.includes(field) ? "— don't import —" : '— choose a column —'}
                  </option>
                  {columns.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="pb-row">
            <button onClick={() => void check()} disabled={busy || !mapping}>
              Preview
            </button>
          </div>
        </>
      )}

      {result && (
        <p className="pb-applies" role="status">
          Recorded {result.imported} payment{result.imported === 1 ? '' : 's'} totalling $
          {result.totalAmount}.
          {result.skipped.length > 0
            ? ` ${result.skipped.length} skipped: ${result.skipped
                .map((s) => {
                  const info = chosenInfo.get(s.dedupeKey);
                  return info ? `$${info.amount} from ${info.payer} — ${s.reason}` : s.reason;
                })
                .join('; ')}.`
            : ''}
        </p>
      )}

      {preview && (
        <>
          {preview.matched.length === 0 && (
            <p className="pb-hint">
              Nothing in {fileName} needs recording &mdash; see below for why.
            </p>
          )}

          {preview.matched.length > 0 && (
            <>
              <h4>Ready to record</h4>
              <ul>
                {preview.matched.map((m) => (
                  <li key={m.dedupeKey}>
                    <label className="pb-inline">
                      <input
                        type="checkbox"
                        checked={choices.get(m.dedupeKey) === m.accountId}
                        onChange={() => toggle(m.dedupeKey, m.accountId)}
                      />{' '}
                      ${m.amount} from {m.clientLabel} on {formatFriendlyDate(m.date)}
                      {m.note ? ` — “${m.note}”` : ''}
                    </label>
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
                  <li key={u.dedupeKey} className="pb-hint">
                    ${u.amount} from {u.payer} on {formatFriendlyDate(u.date)} &mdash; {u.reason}
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

          {preview.alreadyImported.length > 0 && (
            <p className="pb-hint">
              {preview.alreadyImported.length}{' '}
              {preview.alreadyImported.length === 1 ? 'payment' : 'payments'} in this file{' '}
              {preview.alreadyImported.length === 1 ? 'was' : 'were'} imported before and{' '}
              {preview.alreadyImported.length === 1 ? 'is' : 'are'} left alone.
            </p>
          )}

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
