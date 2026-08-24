import { useState } from 'react';
import { adminApi } from '../shared-ui/api.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/** The four datasets, in the order a sitter would rebuild her business from them. */
const DATASETS = [
  {
    key: 'clients',
    label: 'Clients',
    blurb: 'Everyone on your list — names, emails, phone numbers, and their pets.',
  },
  {
    key: 'pets',
    label: 'Pets',
    blurb: 'Every pet with its owners and your care notes, including ones who have died.',
  },
  {
    key: 'bookings',
    label: 'Bookings',
    blurb: 'Every request you have ever had, confirmed, cancelled or declined.',
  },
  {
    key: 'payments',
    label: 'Payments',
    blurb: 'Every payment you have recorded, and what it settled.',
  },
] as const;

/**
 * DOWNLOAD YOUR OWN DATA. A sitter can already bring a client list IN; a product that offers no way
 * back out is asking her to put her whole book somewhere she cannot leave, which is the thing
 * likeliest to stop her starting at all. Four buttons, four plain CSVs, no wizard.
 *
 * A plain `<a href download>` cannot do this: the admin session is a JWT held in localStorage, so
 * the request has to carry an Authorization header, which means fetching the bytes and handing the
 * browser a Blob under a synthetic anchor instead.
 *
 * The failure path is deliberately loud. A download that quietly does nothing reads as "the button
 * is broken" or, worse, as "there was nothing to export" — the one message this feature must never
 * accidentally send.
 */
export function ExportPanel({ session }: { session: Session }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const download = async (dataset: (typeof DATASETS)[number]['key']) => {
    if (busy) return;
    setError('');
    setBusy(dataset);
    try {
      const { blob, filename } = await adminApi.exportCsv(session.slug, session.token, dataset);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on the next tick, not synchronously: some browsers have not finished reading the
      // object URL by the time click() returns, and tearing it down under them cancels the save.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed — try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h3>
        Export your data
        <Hint label="Export your data">
          Everything you have put into Pawservation, as spreadsheets you can open in Excel, Numbers
          or Google Sheets — or hand to another tool. Nothing is left out: pets who have died and
          bookings that were cancelled or declined are all there, with their status in a column,
          because they are part of your record. Downloading changes nothing; take a copy whenever
          you like.
        </Hint>
      </h3>
      <ul>
        {DATASETS.map(({ key, label, blurb }) => (
          <li key={key}>
            <span>
              <strong>{label}</strong>
              <br />
              <span className="pb-hint">{blurb}</span>
            </span>
            <button type="button" disabled={busy !== null} onClick={() => void download(key)}>
              {busy === key ? 'Preparing…' : 'Download CSV'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="pb-error">{error}</p>}
    </>
  );
}
