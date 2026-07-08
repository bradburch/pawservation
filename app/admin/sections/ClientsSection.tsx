import { useState } from 'react';
import type { Customer } from '../../shared-ui/api.js';
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
