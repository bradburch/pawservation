import { useState } from 'react';
import { IconPaw } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';
import { Hint } from '../Hint';

/**
 * Pet-type registry management (0015): the list is pure slug + label — no on/off switch here.
 * Whether a type is bookable derives entirely from each service's Accepted pets list (the chips
 * on every service card under Services). Add/rename/delete are IMMEDIATE calls + settings
 * refresh — the services add/delete pattern. Delete is confirm-guarded; a referenced type
 * surfaces the server's 409 "uncheck it under each service's Accepted pets" copy via the
 * dashboard error banner.
 */
export function PetsSection({
  settings,
  addPetType,
  renamePetType,
  removePetType,
}: {
  settings: Settings;
  addPetType: (label: string) => Promise<void>;
  renamePetType: (petType: string, label: string) => Promise<void>;
  removePetType: (petType: string) => Promise<void>;
}) {
  const [newLabel, setNewLabel] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const submitAdd = async () => {
    if (busy || !newLabel.trim()) return;
    setBusy(true);
    try {
      await addPetType(newLabel.trim());
      setNewLabel('');
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (petType: string) => {
    if (busy || !editLabel.trim()) return;
    setBusy(true);
    try {
      await renamePetType(petType, editLabel.trim());
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>
        <IconPaw size={18} /> Pets you care for
        <Hint label="Pet types">
          The animal types your business handles, used when you add a client&apos;s pets. Which
          services accept each type is set per service, under Services &amp; rates.
        </Hint>
      </h2>
      <p className="pb-applies">
        The list of pet types your business knows about — add your own (rabbits, birds, reptiles…).
        Which types each service takes is set per service: use the Accepted pets checkboxes on each
        service&apos;s card under Services. Your clients&apos; individual pets live under Clients.
      </p>
      {settings.petTypes.map((p) => (
        <div className="pb-inline" key={p.petType}>
          <span>{p.label}</span>
          {editing === p.petType ? (
            <>
              <input
                value={editLabel}
                aria-label={`New name for ${p.label}`}
                onChange={(e) => setEditLabel(e.target.value)}
              />
              <button type="button" disabled={busy} onClick={() => void submitRename(p.petType)}>
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(p.petType);
                  setEditLabel(p.label);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="pb-danger"
                onClick={() => {
                  if (!window.confirm(`Delete "${p.label}"? This removes it immediately.`)) return;
                  void removePetType(p.petType);
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      ))}
      <div className="pb-inline">
        <input
          type="text"
          placeholder="Pet type name (e.g. Rabbits)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button type="button" onClick={() => void submitAdd()} disabled={busy}>
          {busy ? 'Adding…' : 'Add a pet type'}
        </button>
      </div>
    </>
  );
}
