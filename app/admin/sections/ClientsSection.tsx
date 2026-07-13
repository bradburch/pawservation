import { useState } from 'react';
import type { Customer, ImportResult } from '../../shared-ui/api.js';
import { adminApi } from '../../shared-ui/api.js';
import { IconUsers } from '../../shared-ui/icons';

function PetAdder({
  customer,
  enabledPetTypes,
  slug,
  token,
  onAdded,
  onError,
  clearError,
}: {
  customer: Customer;
  enabledPetTypes: string[];
  slug: string;
  token: string;
  onAdded: () => void;
  onError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [name, setName] = useState('');
  const [petType, setPetType] = useState(enabledPetTypes[0]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim() || busy) return;
    clearError();
    setBusy(true);
    try {
      await adminApi.customers.addPet(slug, token, customer.id, name.trim(), petType, notes.trim());
      setName('');
      setNotes('');
      onAdded();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-row pb-add-pet">
      <input placeholder="Pet name" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={petType} onChange={(e) => setPetType(e.target.value)}>
        {enabledPetTypes.map((pt) => (
          <option key={pt} value={pt}>
            {pt === 'dog' ? 'Dog' : 'Cat'}
          </option>
        ))}
      </select>
      <input
        placeholder="Care notes (feeding, meds, quirks — optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button onClick={() => void add()} disabled={busy || !name.trim()}>
        {busy ? 'Adding…' : 'Add pet'}
      </button>
    </div>
  );
}

export function ClientsSection({
  customers,
  enabledPetTypes,
  slug,
  token,
  onCustomersChanged,
  handleError,
  clearError,
}: {
  customers: Customer[];
  enabledPetTypes: string[];
  slug: string;
  token: string;
  onCustomersChanged: () => void;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [custEmail, setCustEmail] = useState('');
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [sendInvites, setSendInvites] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);

  /** Matches the old Dashboard run() semantics: clear the error banner at the START of each
   * action (so a stale error from an earlier failure doesn't outlive a later action), run the
   * mutation, refresh the list on success, and route failures through the shared handler. */
  const mutate = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      await fn();
      onCustomersChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const addCustomer = () =>
    mutate(async () => {
      await adminApi.customers.add(
        slug,
        token,
        custEmail.trim().toLowerCase(),
        custName.trim(),
        custPhone.trim(),
      );
      setCustEmail('');
      setCustName('');
      setCustPhone('');
    });

  const removeCustomer = (id: string) => mutate(() => adminApi.customers.remove(slug, token, id));

  const removePet = (endUserId: string, petId: string) =>
    mutate(() => adminApi.customers.removePet(slug, token, endUserId, petId));

  const runImport = async () => {
    if (!csvFile || importing) return;
    clearError();
    setImporting(true);
    try {
      const csv = await csvFile.text();
      const result = await adminApi.customers.import(slug, token, csv, sendInvites);
      setImportResult(result);
      setCsvFile(null);
      setFileInputKey((k) => k + 1);
      onCustomersChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <h2>
        <IconUsers size={18} /> Your clients
      </h2>
      <p className="pb-applies">
        Only clients you invite can book — adding one sends them an invite by email.
      </p>
      <div className="pb-row">
        <input
          type="email"
          placeholder="customer@email.com"
          value={custEmail}
          onChange={(e) => setCustEmail(e.target.value)}
        />
        <input
          type="text"
          placeholder="Name (optional)"
          value={custName}
          onChange={(e) => setCustName(e.target.value)}
        />
        <input
          type="tel"
          placeholder="Phone (optional)"
          value={custPhone}
          onChange={(e) => setCustPhone(e.target.value)}
        />
        <button onClick={() => void addCustomer()} disabled={busy}>
          {busy ? 'Adding…' : 'Add customer'}
        </button>
      </div>
      <div className="pb-row">
        <input
          key={fileInputKey}
          type="file"
          accept=".csv"
          onChange={(e) => {
            setCsvFile(e.target.files?.[0] ?? null);
            setImportResult(null);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={sendInvites}
            onChange={(e) => setSendInvites(e.target.checked)}
          />{' '}
          Send invite emails to new clients
        </label>
        <button onClick={() => void runImport()} disabled={!csvFile || importing}>
          {importing ? 'Importing…' : 'Import'}
        </button>
        <a href="/clients-import-example.csv" download>
          Download example CSV
        </a>
      </div>
      {importResult && (
        <div className="pb-row">
          <p>
            Imported {importResult.importedCustomers} client
            {importResult.importedCustomers === 1 ? '' : 's'} and {importResult.importedPets} pet
            {importResult.importedPets === 1 ? '' : 's'}.
            {importResult.invitesSent > 0 ? ` Sent ${importResult.invitesSent} invite(s).` : ''}
            {importResult.invitesFailed > 0
              ? ` ${importResult.invitesFailed} invite(s) failed to send.`
              : ''}
          </p>
          {importResult.skippedRows.length > 0 && (
            <ul>
              {importResult.skippedRows.map((r) => (
                <li key={r.row}>
                  Row {r.row}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ul>
        {customers.map((cust) => (
          <li key={cust.id} className="pb-customer">
            <div className="pb-row">
              <span>
                {cust.email}
                {cust.name ? ` (${cust.name})` : ''}
                {cust.phone ? ` · ${cust.phone}` : ''}{' '}
                <span
                  className={`pb-chip${cust.status === 'active' ? ' pb-chip-ok' : ' pb-chip-warn'}`}
                >
                  {cust.status.charAt(0).toUpperCase() + cust.status.slice(1)}
                </span>
              </span>
              <button onClick={() => void removeCustomer(cust.id)} disabled={busy}>
                Remove
              </button>
            </div>
            <ul className="pb-pets">
              {cust.pets.map((p) => (
                <li key={p.id}>
                  {p.name} <em>{p.petType}</em>
                  {p.notes ? <span className="pb-hint"> — {p.notes}</span> : null}
                  <button onClick={() => void removePet(cust.id, p.id)} disabled={busy}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {enabledPetTypes.length > 0 && (
              <PetAdder
                customer={cust}
                enabledPetTypes={enabledPetTypes}
                slug={slug}
                token={token}
                onAdded={onCustomersChanged}
                onError={handleError}
                clearError={clearError}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
