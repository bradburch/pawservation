import { useState } from 'react';
import type { Settings } from '../shared.js';

function AddServiceForm({
  templates,
  addService,
}: {
  templates: Settings['templates'];
  addService: (template: string, label: string) => Promise<void>;
}) {
  const [template, setTemplate] = useState(templates[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !label.trim() || !template) return;
    setBusy(true);
    try {
      await addService(template, label.trim());
      setLabel('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-inline">
      <select value={template} onChange={(e) => setTemplate(e.target.value)}>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="Service name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button type="button" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Adding…' : 'Add service'}
      </button>
    </div>
  );
}

/**
 * The dashed "add" tile at the end of the services grid. Expands — through the
 * same full-width grid mechanism as the service cards — the existing
 * AddServiceForm. Add stays an immediate POST + refresh, outside the save-bar
 * draft, exactly as before the redesign.
 */
export function AddServiceTile({
  templates,
  addService,
  expanded,
  onToggleExpanded,
  openRef,
}: {
  templates: Settings['templates'];
  addService: (template: string, label: string) => Promise<void>;
  expanded: boolean;
  onToggleExpanded: () => void;
  openRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`pb-tile-btn pb-svc-add${expanded ? ' pb-svc-expanded' : ''}`}
        aria-expanded={expanded}
        aria-controls={expanded ? 'pb-svc-editor-add' : undefined}
        onClick={onToggleExpanded}
        ref={openRef}
      >
        + Add a service
      </button>
      {expanded && (
        <div
          className="pb-svc-editor"
          role="region"
          aria-label="Add a service"
          id="pb-svc-editor-add"
        >
          <h3>Add a service</h3>
          <AddServiceForm templates={templates} addService={addService} />
        </div>
      )}
    </>
  );
}
