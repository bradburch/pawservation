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
}: {
  customer: Customer;
  enabledPetTypes: string[];
  slug: string;
  token: string;
  onAdded: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [petType, setPetType] = useState(enabledPetTypes[0]);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await adminApi.customers.addPet(slug, token, customer.id, name.trim(), petType);
      setName('');
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
}: {
  customers: Customer[];
  enabledPetTypes: string[];
  slug: string;
  token: string;
  onCustomersChanged: () => void;
  handleError: (e: unknown) => void;
}) {
  const [custEmail, setCustEmail] = useState('');
  const [custName, setCustName] = useState('');
  const [busy, setBusy] = useState(false);

  const addCustomer = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi.customers.add(slug, token, custEmail.trim().toLowerCase(), custName.trim());
      setCustEmail('');
      setCustName('');
      onCustomersChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const removeCustomer = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi.customers.remove(slug, token, id);
      onCustomersChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
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
                {cust.name ? ` (${cust.name})` : ''}{' '}
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
                  <button
                    onClick={() => void (async () => {
                      if (busy) return;
                      setBusy(true);
                      try {
                        await adminApi.customers.removePet(slug, token, cust.id, p.id);
                        onCustomersChanged();
                      } catch (e) {
                        handleError(e);
                      } finally {
                        setBusy(false);
                      }
                    })()}
                    disabled={busy}
                  >
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
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
