import { useState } from 'react';
import type { Customer, ImportResult } from '../../shared-ui/api.js';
import { IconUsers } from '../../shared-ui/icons';

function PetAdder({
  customer,
  enabledPetTypes,
  onAdd,
}: {
  customer: Customer;
  enabledPetTypes: string[];
  onAdd: (endUserId: string, name: string, petType: string) => void;
}) {
  const [name, setName] = useState('');
  const [petType, setPetType] = useState(enabledPetTypes[0]);
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
      <button
        onClick={() => {
          if (name.trim()) {
            onAdd(customer.id, name.trim(), petType);
            setName('');
          }
        }}
      >
        Add pet
      </button>
    </div>
  );
}

export function ClientsSection({
  customers,
  custEmail,
  custName,
  setCustEmail,
  setCustName,
  addCustomer,
  removeCustomer,
  addPet,
  removePet,
  enabledPetTypes,
  importCsv,
}: {
  customers: Customer[];
  custEmail: string;
  custName: string;
  setCustEmail: (value: string) => void;
  setCustName: (value: string) => void;
  addCustomer: () => Promise<void>;
  removeCustomer: (id: string) => Promise<void>;
  addPet: (endUserId: string, name: string, petType: string) => Promise<void>;
  removePet: (endUserId: string, petId: string) => Promise<void>;
  enabledPetTypes: string[];
  importCsv: (csv: string, sendInvites: boolean) => Promise<ImportResult | null>;
}) {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [sendInvites, setSendInvites] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  const runImport = async () => {
    if (!csvFile || importing) return;
    setImporting(true);
    try {
      const csv = await csvFile.text();
      const result = await importCsv(csv, sendInvites);
      if (result) setImportResult(result);
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
        <button onClick={() => void addCustomer()}>Add customer</button>
      </div>
      <div className="pb-row">
        <input
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
                {cust.name ? ` (${cust.name})` : ''}{' '}
                <span
                  className={`pb-chip${cust.status === 'active' ? ' pb-chip-ok' : ' pb-chip-warn'}`}
                >
                  {cust.status.charAt(0).toUpperCase() + cust.status.slice(1)}
                </span>
              </span>
              <button onClick={() => void removeCustomer(cust.id)}>Remove</button>
            </div>
            <ul className="pb-pets">
              {cust.pets.map((p) => (
                <li key={p.id}>
                  {p.name} <em>{p.petType}</em>
                  <button onClick={() => void removePet(cust.id, p.id)}>Remove</button>
                </li>
              ))}
            </ul>
            {enabledPetTypes.length > 0 && (
              <PetAdder customer={cust} enabledPetTypes={enabledPetTypes} onAdd={addPet} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
