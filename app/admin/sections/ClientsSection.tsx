import { useEffect, useState } from 'react';
import { buildGroupKey, groupIntoAccounts, isValidRate } from '../../../src/shared/index.js';
import type { AccountGroup } from '../../../src/shared/index.js';
import type { Customer, ImportResult, Pet, PetGroupRate } from '../../shared-ui/api.js';
import { adminApi } from '../../shared-ui/api.js';
import { IconUsers } from '../../shared-ui/icons';
import { Hint } from '../Hint';
import type { ServiceForm } from '../shared.js';

/** The full pet-type registry entry (slug + display label), same shape as `Settings.petTypes`. */
type PetType = { petType: string; label: string };

/** Name first, per the accounts UI: "Tina Alvarez (tina@example.com)". Email alone if no name. */
function ownerLabel(c: Customer): string {
  return c.name ? `${c.name} (${c.email})` : c.email;
}

/** Short form for the card title — "Tina & Rob". */
function ownerShort(c: Customer): string {
  return c.name ?? c.email;
}

/** Case-insensitive display order, id tie-break so the order is stable across reloads. */
function ownerSortKey(c: Customer): string {
  return `${ownerShort(c).toLowerCase()} ${c.id}`;
}

function PetAdder({
  owners,
  petTypes,
  slug,
  token,
  onAdded,
  onError,
  clearError,
}: {
  /** Every owner on the account, first one first — the pet is created under [0] and linked to the rest. */
  owners: Customer[];
  petTypes: PetType[];
  slug: string;
  token: string;
  onAdded: () => void;
  onError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [name, setName] = useState('');
  // Value held here is the slug (what the server expects), not the label. Just the user's last
  // pick, not necessarily a valid one right now — see `selectedPetType` below.
  const [petType, setPetType] = useState(petTypes[0]?.petType ?? '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Derived, not synced via an effect: `petType` goes stale if the registry changes while this
  // stays mounted (every section stays mounted — see App.tsx), e.g. the sitter removes the
  // currently-selected type in the Pet types section. Falling back here — rather than writing
  // the fallback back into `petType` — means the <select>, and what `add()` submits, are always
  // in sync with the current registry without a render-then-setState round trip.
  const selectedPetType = petTypes.some((pt) => pt.petType === petType)
    ? petType
    : (petTypes[0]?.petType ?? '');

  const add = async () => {
    const primary = owners[0];
    if (!name.trim() || busy || !primary) return;
    clearError();
    setBusy(true);
    const petName = name.trim();
    try {
      const pet = await adminApi.customers.addPet(
        slug,
        token,
        primary.id,
        petName,
        selectedPetType,
        notes.trim(),
      );
      // The route creates the pet under ONE customer. Everyone else on the account has to be
      // linked explicitly, or a co-owner could not see or book the pet they share.
      const linked = await Promise.allSettled(
        owners.slice(1).map((o) => adminApi.customers.addPetOwner(slug, token, pet.id, o.id)),
      );
      setName('');
      setNotes('');
      onAdded();
      if (linked.some((r) => r.status === 'rejected')) {
        onError(
          new Error(
            `${petName} was added, but not every owner could be linked. Use "Add owner to this account" to finish.`,
          ),
        );
      }
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-row pb-add-pet">
      <input placeholder="Pet name" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={selectedPetType} onChange={(e) => setPetType(e.target.value)}>
        {petTypes.map((pt) => (
          <option key={pt.petType} value={pt.petType}>
            {pt.label}
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

/**
 * The client's Venmo handle. Only needed when it differs from the name the sitter has for them —
 * the Venmo CSV importer matches on the name otherwise — so the label says exactly that and the
 * field starts empty for almost everybody. Saves explicitly (the dirty/Save affordance the rest of
 * the dashboard uses) rather than on blur, so a half-typed handle is never written.
 */
function VenmoField({
  customer,
  slug,
  token,
  onSaved,
  onError,
  clearError,
}: {
  customer: Customer;
  slug: string;
  token: string;
  onSaved: () => void;
  onError: (e: unknown) => void;
  clearError: () => void;
}) {
  const saved = customer.venmoUsername ?? '';
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const dirty = value.trim() !== saved;

  const save = async () => {
    if (!dirty || busy) return;
    clearError();
    setBusy(true);
    try {
      const next = value.trim();
      await adminApi.customers.setVenmo(slug, token, customer.id, next === '' ? null : next);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-row pb-venmo-field">
      <label className="pb-inline">
        Venmo username (if different from their name)
        <input
          value={value}
          placeholder="@their-venmo"
          maxLength={31}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button onClick={() => void save()} disabled={!dirty || busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {!dirty && saved !== '' && <span className="pb-hint">Saved</span>}
    </div>
  );
}

/** One (service, option) pair this account's rate editor can price — enabled services only, and
 *  only options that have already been saved (a brand-new option has no optionKey yet). */
type EnabledOption = {
  serviceType: string;
  serviceLabel: string;
  rateUnit: string;
  optionKey: string;
  optionLabel: string;
};

function enabledOptionsFor(services: ServiceForm[]): EnabledOption[] {
  return services
    .filter((s) => s.enabled)
    .flatMap((s) =>
      s.options
        .filter((o) => o.optionKey !== undefined)
        .map((o) => ({
          serviceType: s.type,
          serviceLabel: s.label,
          rateUnit: s.rateUnit,
          optionKey: o.optionKey as string,
          optionLabel: o.label,
        })),
    );
}

/**
 * One row of the account-card rate editor: an optional override rate for THIS account's full
 * live pet set, for one (service, option). Writes go straight to the PetGroupPricing routes —
 * unlike the staged Services-section draft, there is no save bar here, so Save/Clear act
 * immediately. Keyed by the caller on the override's id (or 'new') so a save/clear round trip
 * remounts this row and its local `value` picks up the fresh server state instead of going stale.
 */
function AccountRateRow({
  slug,
  token,
  group,
  option,
  override,
  busy,
  mutateRates,
}: {
  slug: string;
  token: string;
  group: AccountGroup;
  option: EnabledOption;
  override?: PetGroupRate;
  busy: boolean;
  mutateRates: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState<number | ''>(override?.rate ?? '');

  const save = () =>
    mutateRates(() =>
      adminApi.petGroupRates.upsert(slug, token, {
        serviceType: option.serviceType,
        optionKey: option.optionKey,
        petIds: group.livePetIds,
        rate: value === '' ? 0 : value, // isValidRate gates the button below; 0 never ships
      }),
    );
  const clearOverride = () => {
    if (!override) return;
    void mutateRates(() => adminApi.petGroupRates.remove(slug, token, override.id));
  };

  return (
    <div className="pb-row pb-account-rate-row">
      <span>
        {option.serviceLabel} — {option.optionLabel}
      </span>
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        aria-label={`${option.serviceLabel} ${option.optionLabel} rate for this account`}
        aria-invalid={value !== '' && !isValidRate(value)}
        placeholder="Base rate applies"
        value={value}
        onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
      />
      <span className="pb-hint">/{option.rateUnit}</span>
      <button type="button" onClick={() => void save()} disabled={busy || !isValidRate(value)}>
        {override ? 'Update' : 'Save'}
      </button>
      {override && (
        <button type="button" onClick={clearOverride} disabled={busy}>
          Clear
        </button>
      )}
    </div>
  );
}

export function ClientsSection({
  customers,
  petTypes,
  services,
  slug,
  token,
  onCustomersChanged,
  handleError,
  clearError,
}: {
  customers: Customer[];
  petTypes: PetType[];
  services: ServiceForm[];
  slug: string;
  token: string;
  onCustomersChanged: () => void;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [custEmail, setCustEmail] = useState('');
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [custPetName, setCustPetName] = useState('');
  // Slug of the user's last pick — may go stale if the registry changes; see PetAdder above for
  // why the valid value is DERIVED (selectedCustPetType) rather than synced back via an effect.
  const [custPetType, setCustPetType] = useState(petTypes[0]?.petType ?? '');
  const [busy, setBusy] = useState(false);
  const selectedCustPetType = petTypes.some((pt) => pt.petType === custPetType)
    ? custPetType
    : (petTypes[0]?.petType ?? '');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [sendInvites, setSendInvites] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [welcomeHint, setWelcomeHint] = useState<string | null>(null);

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

  /** Owner-level actions span EVERY live pet in the account, so they can fail part-way — and a
   *  partial link is real state, not a rolled-back attempt. The list is therefore refreshed
   *  whichever way it goes, and a failure is reported with a count and a next step rather than as
   *  a bare error. `addPetOwner` is INSERT OR IGNORE server-side, so retrying is safe. */
  const fanOut = async (
    calls: Promise<unknown>[],
    onPartial: (done: number, total: number) => string,
  ) => {
    if (busy) return;
    clearError();
    setBusy(true);
    const results = await Promise.allSettled(calls);
    setBusy(false);
    onCustomersChanged();
    const done = results.filter((r) => r.status === 'fulfilled').length;
    if (done < results.length) handleError(new Error(onPartial(done, results.length)));
  };

  // ── Account-card rate editor (PetGroupPricing) ──────────────────────────────────────────
  // Loaded once for the whole section (every account's editor reads the same list, filtered
  // client-side by groupKey) rather than per-card, to avoid one fetch per account.
  const [groupRates, setGroupRates] = useState<PetGroupRate[] | null>(null);

  useEffect(() => {
    let active = true;
    adminApi.petGroupRates
      .list(slug, token)
      .then((res) => {
        if (active) setGroupRates(res.rates);
      })
      .catch((e) => {
        if (active) handleError(e);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, token]);

  /** Same shape as `mutate` above, but refreshes the rate list instead of the customer list —
   *  a rate save/clear never changes who's on an account. */
  const mutateRates = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      await fn();
      const { rates } = await adminApi.petGroupRates.list(slug, token);
      setGroupRates(rates);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const enabledOptions = enabledOptionsFor(services);

  // Pet rows must show the registry LABEL ("Dog"), not the raw slug ("dog") — the one place
  // that still bypassed the label map.
  const labelBySlug = new Map(petTypes.map((pt) => [pt.petType, pt.label]));

  // ── Accounts ──────────────────────────────────────────────────────────────
  // GET /admin/customers returns one pets array PER OWNER LINK, so a co-owned pet appears under
  // EVERY owner: the payload is already a faithful edge list and the accounts derive client-side
  // with no extra endpoint. Pinned by "lists a co-owned pet under BOTH owners, and keeps deceased
  // pets in the payload" in server/__tests__/customers-admin.test.ts.
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const petById = new Map<string, Pet>();
  const ownerIdsByPet = new Map<string, Set<string>>();
  for (const cust of customers) {
    for (const pet of cust.pets) {
      // Every copy of a pet row is field-identical (the owner id lives on the LINK, not the pet),
      // so first-wins is safe.
      if (!petById.has(pet.id)) petById.set(pet.id, pet);
      const owners = ownerIdsByPet.get(pet.id) ?? new Set<string>();
      owners.add(cust.id);
      ownerIdsByPet.set(pet.id, owners);
    }
  }

  const groups = groupIntoAccounts(
    customers.map((cust) => ({
      ownerId: cust.id,
      livePetIds: cust.pets.filter((p) => !p.deceasedAt).map((p) => p.id),
      deceasedPetIds: cust.pets.filter((p) => p.deceasedAt).map((p) => p.id),
    })),
  );

  const petsOf = (ids: string[]): Pet[] =>
    ids
      .map((id) => petById.get(id))
      .filter((p): p is Pet => p !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  // groupIntoAccounts orders by pet id (deterministic, but meaningless to a human), so the cards
  // are re-sorted for display: active accounts first, then each by its first owner's name.
  const cards = groups
    .map((group) => ({
      group,
      owners: group.ownerIds
        .map((id) => customerById.get(id))
        .filter((c): c is Customer => c !== undefined)
        .sort((a, b) => ownerSortKey(a).localeCompare(ownerSortKey(b))),
    }))
    .sort((a, b) => {
      if (a.group.active !== b.group.active) return a.group.active ? -1 : 1;
      const an = a.owners[0] ? ownerSortKey(a.owners[0]) : '';
      const bn = b.owners[0] ? ownerSortKey(b.owners[0]) : '';
      return an.localeCompare(bn) || a.group.key.localeCompare(b.group.key);
    });

  // Every client is added WITH their first pet — the server refuses a pet-less create, so the
  // form requires name + pet before Add enables.
  const canAddCustomer =
    custEmail.trim() !== '' &&
    custName.trim() !== '' &&
    custPetName.trim() !== '' &&
    selectedCustPetType !== '';

  const addCustomer = () =>
    mutate(async () => {
      setWelcomeHint(null);
      const email = custEmail.trim().toLowerCase();
      await adminApi.customers.add(
        slug,
        token,
        email,
        custName.trim(),
        custPhone.trim(),
        custPetName.trim(),
        selectedCustPetType,
      );
      setWelcomeHint(
        `${email} added. No email has been sent — use "Send welcome email" on their row when you're ready.`,
      );
      setCustEmail('');
      setCustName('');
      setCustPhone('');
      setCustPetName('');
    });

  const removeCustomer = (id: string) => mutate(() => adminApi.customers.remove(slug, token, id));

  const sendWelcome = (cust: Customer) =>
    mutate(async () => {
      setWelcomeHint(null);
      await adminApi.customers.sendWelcome(slug, token, cust.id);
      setWelcomeHint(`Welcome email sent to ${cust.email}.`);
    });

  const removePet = (endUserId: string, petId: string) =>
    mutate(() => adminApi.customers.removePet(slug, token, endUserId, petId));

  // Co-ownership (0019): a pet can have several owners, so pets are listed once per ACCOUNT
  // rather than once per client. Owner-level linking lives on the account card (see below).
  const setPetDeceased = (petId: string, deceased: boolean) =>
    mutate(() => adminApi.customers.setPetDeceased(slug, token, petId, deceased));

  const addOwnerToAccount = (group: AccountGroup, endUserId: string) =>
    void fanOut(
      group.livePetIds.map((petId) =>
        adminApi.customers.addPetOwner(slug, token, petId, endUserId),
      ),
      (done, total) => `Linked to ${done} of ${total} pets — choose them again to finish.`,
    );

  /** Only the pets this owner actually owns are unlinked; the server refuses to drop a pet's LAST
   *  owner (409), which is exactly right and is what the partial message explains. */
  const removeOwnerFromAccount = (group: AccountGroup, endUserId: string) =>
    void fanOut(
      group.livePetIds
        .filter((petId) => ownerIdsByPet.get(petId)?.has(endUserId))
        .map((petId) => adminApi.customers.removePetOwner(slug, token, petId, endUserId)),
      (done, total) =>
        `Removed from ${done} of ${total} pets — the rest would be left with no owner. Remove those pets, or remove the client.`,
    );

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
        <Hint label="Clients">
          Only people on this list can book with you. Clients who share a pet are grouped into one
          account — add an owner to an account and they get access to all of its pets. Adding a
          client never emails them — send the welcome email from their row when you're ready.
        </Hint>
      </h2>
      <p className="pb-applies">
        Only clients you add can book. Every client is added together with their first pet — that
        pair starts an <strong>account</strong>. People who share a pet are one account: they see
        the same pets and are billed together. Nothing is emailed until you choose to send a welcome
        email.
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
          placeholder="Name"
          value={custName}
          onChange={(e) => setCustName(e.target.value)}
        />
        <input
          type="tel"
          placeholder="Phone (optional)"
          value={custPhone}
          onChange={(e) => setCustPhone(e.target.value)}
        />
        <input
          type="text"
          placeholder="Pet name"
          value={custPetName}
          onChange={(e) => setCustPetName(e.target.value)}
        />
        <select
          value={selectedCustPetType}
          onChange={(e) => setCustPetType(e.target.value)}
          aria-label="Pet type"
        >
          {petTypes.map((pt) => (
            <option key={pt.petType} value={pt.petType}>
              {pt.label}
            </option>
          ))}
        </select>
        <button onClick={() => void addCustomer()} disabled={busy || !canAddCustomer}>
          {busy ? 'Adding…' : 'Add account'}
        </button>
      </div>
      {welcomeHint && (
        <p className="pb-applies" role="status">
          {welcomeHint}
        </p>
      )}
      {petTypes.length === 0 && (
        <p className="pb-applies">
          Add a pet type in Pet types first — a client can only be added together with a pet.
        </p>
      )}
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
        <label className="pb-inline">
          <input
            type="checkbox"
            checked={sendInvites}
            onChange={(e) => setSendInvites(e.target.checked)}
          />{' '}
          Send welcome emails to new clients
        </label>
        <button onClick={() => void runImport()} disabled={!csvFile || importing}>
          {importing ? 'Importing…' : 'Import'}
        </button>
        <a href="/clients-import-example.csv" download>
          Download example CSV
        </a>
      </div>
      <p className="pb-applies">
        One row per pet, repeating the email for a client with several pets — the name only has to
        appear once. Every client needs at least one pet: rows that would leave a client with none,
        or a new client with no name, are skipped and listed back to you.
      </p>
      {importResult && (
        <div className="pb-row">
          <p>
            Imported {importResult.importedCustomers} client
            {importResult.importedCustomers === 1 ? '' : 's'} and {importResult.importedPets} pet
            {importResult.importedPets === 1 ? '' : 's'}.
            {importResult.invitesSent > 0
              ? ` Sent ${importResult.invitesSent} welcome email(s).`
              : ''}
            {importResult.invitesFailed > 0
              ? ` ${importResult.invitesFailed} welcome email(s) failed to send.`
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
      <ul className="pb-accounts">
        {cards.map(({ group, owners }) => {
          const livePets = petsOf(group.livePetIds);
          const gonePets = petsOf(group.deceasedPetIds);
          const title = owners.map(ownerShort).join(' & ');
          // "Remove pet" is keyed on the pet server-side; the customer id in the URL is only
          // required to be a real client of this tenant. Pass an owner who actually owns the pet.
          const ownerIdFor = (pet: Pet): string =>
            owners.find((o) => ownerIdsByPet.get(pet.id)?.has(o.id))?.id ?? owners[0]?.id ?? '';
          return (
            <li key={group.key} className="pb-account">
              <div className="pb-account-head">
                <strong>{title}</strong>
                {group.active ? null : <span className="pb-chip pb-chip-warn">No active pets</span>}
              </div>
              <ul className="pb-owners">
                {owners.map((owner) => (
                  <li key={owner.id}>
                    <span>
                      {ownerLabel(owner)}
                      {owner.phone ? ` · ${owner.phone}` : ''}{' '}
                      <span
                        className={`pb-chip${owner.status === 'active' ? ' pb-chip-ok' : ' pb-chip-warn'}`}
                      >
                        {owner.status.charAt(0).toUpperCase() + owner.status.slice(1)}
                      </span>
                    </span>
                    <button onClick={() => void sendWelcome(owner)} disabled={busy}>
                      Send welcome email
                    </button>
                    <button
                      onClick={() => removeOwnerFromAccount(group, owner.id)}
                      disabled={busy || owners.length < 2 || group.livePetIds.length === 0}
                      title={
                        owners.length < 2
                          ? 'The only owner of these pets — remove the client instead.'
                          : group.livePetIds.length === 0
                            ? 'This account has no active pets — there is nothing to unlink.'
                            : undefined
                      }
                    >
                      Remove from account
                    </button>
                    <button onClick={() => void removeCustomer(owner.id)} disabled={busy}>
                      Remove client
                    </button>
                    <VenmoField
                      customer={owner}
                      slug={slug}
                      token={token}
                      onSaved={onCustomersChanged}
                      onError={handleError}
                      clearError={clearError}
                    />
                  </li>
                ))}
              </ul>
              {livePets.length + gonePets.length === 0 ? (
                <p className="pb-applies">No pets on this account — add one below.</p>
              ) : (
                <ul className="pb-pets">
                  {[...livePets, ...gonePets].map((p) => (
                    <li key={p.id}>
                      {p.name} <em>{labelBySlug.get(p.petType) ?? p.petType}</em>
                      {p.deceasedAt ? <span className="pb-chip pb-chip-warn">Deceased</span> : null}
                      {p.notes ? <span className="pb-hint"> — {p.notes}</span> : null}
                      <button
                        onClick={() => void setPetDeceased(p.id, !p.deceasedAt)}
                        disabled={busy}
                      >
                        {p.deceasedAt ? 'Mark alive' : 'Mark deceased'}
                      </button>
                      <button onClick={() => void removePet(ownerIdFor(p), p.id)} disabled={busy}>
                        Remove pet
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {group.active && customers.length > owners.length ? (
                <div className="pb-row pb-add-owner">
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addOwnerToAccount(group, e.target.value);
                    }}
                    disabled={busy}
                    aria-label={`Add owner to ${title}`}
                  >
                    <option value="">Add owner to this account…</option>
                    {customers
                      .filter((c) => !group.ownerIds.includes(c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {ownerLabel(c)}
                        </option>
                      ))}
                  </select>
                  <span className="pb-hint">
                    Links them to every pet on this account. If they already have pets of their own,
                    the two accounts merge into one.
                  </span>
                </div>
              ) : null}
              {petTypes.length > 0 && owners[0] ? (
                <PetAdder
                  owners={owners}
                  petTypes={petTypes}
                  slug={slug}
                  token={token}
                  onAdded={onCustomersChanged}
                  onError={handleError}
                  clearError={clearError}
                />
              ) : null}
              {group.active && (
                <details className="pb-account-rates">
                  <summary>Rates for this account</summary>
                  <p className="pb-hint">
                    Rates for specific pets beat species rates beat the base rate.
                  </p>
                  <p className="pb-hint">
                    Covers all of this account&rsquo;s pets together. Pricing a subset of the
                    account&rsquo;s pets isn&rsquo;t editable in the dashboard yet. Changing this
                    account&rsquo;s pets clears its saved rate.
                  </p>
                  {enabledOptions.length === 0 ? (
                    <p className="pb-applies">
                      No enabled services with saved options yet — save your services first.
                    </p>
                  ) : (
                    enabledOptions.map((option) => {
                      const key = buildGroupKey(group.livePetIds);
                      const override = groupRates?.find(
                        (r) =>
                          r.serviceType === option.serviceType &&
                          r.optionKey === option.optionKey &&
                          buildGroupKey(r.petIds) === key,
                      );
                      return (
                        <AccountRateRow
                          key={`${option.serviceType}:${option.optionKey}:${override?.id ?? 'new'}`}
                          slug={slug}
                          token={token}
                          group={group}
                          option={option}
                          override={override}
                          busy={busy}
                          mutateRates={mutateRates}
                        />
                      );
                    })
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
