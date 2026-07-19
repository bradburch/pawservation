import { Fragment, useRef, useState } from 'react';
import { IconTag } from '../../shared-ui/icons';
import { ServiceCard } from './ServiceCard.js';
import { ServiceEditor } from './ServiceEditor.js';
import type { ServiceForm, Settings, SettingsSectionProps } from '../shared.js';

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

export function ServicesSection({
  settings,
  setSettings,
  addService,
  removeService,
  openWizard,
}: SettingsSectionProps & {
  addService: (template: string, label: string) => Promise<void>;
  removeService: (type: string) => Promise<void>;
  openWizard: () => void;
}) {
  // Which editor is open: a service type, or null. One at a time — expanding
  // another collapses the first. Collapsing never loses edits: all field state
  // lives in the staged settings draft; the save bar is the single source of
  // truth for unsaved changes. Local state, unaddressed by the #services hash.
  const [expanded, setExpanded] = useState<string | null>(null);
  // Done returns focus to the tapped card's expand button.
  const openRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const toggle = (key: string) => setExpanded((cur) => (cur === key ? null : key));
  const collapse = (key: string) => {
    setExpanded(null);
    openRefs.current.get(key)?.focus();
  };

  return (
    <>
      <h2>
        <IconTag size={18} /> Services &amp; rates
      </h2>
      <p>
        <button type="button" onClick={openWizard}>
          Quick setup
        </button>{' '}
        <span className="pb-hint">
          One-tap presets for common offerings — additive, never overwrites.
        </span>
      </p>
      <p className="pb-applies">
        Tap a card to edit pricing, questions, and limits; the switch turns a service on or off. To
        create a new offering clients can book (say, a 30-minute &ldquo;Puppy Check-in&rdquo;), add
        it as an option under Walks or Check-ins with its own name, length, and price.
      </p>
      <div className="pb-svc-grid">
        {settings.services.map((s, si) => {
          const setService = (next: ServiceForm) => {
            const services = [...settings.services];
            services[si] = next;
            setSettings({ ...settings, services });
          };
          const editorId = `pb-svc-editor-${s.type}`;
          const titleId = `pb-svc-title-${s.type}`;
          return (
            <Fragment key={s.type}>
              <ServiceCard
                service={s}
                expanded={expanded === s.type}
                editorId={editorId}
                titleId={titleId}
                onToggleEnabled={(enabled) => setService({ ...s, enabled })}
                onToggleExpanded={() => toggle(s.type)}
                openRef={(el) => openRefs.current.set(s.type, el)}
              />
              {expanded === s.type && (
                <ServiceEditor
                  service={s}
                  setService={setService}
                  id={editorId}
                  labelledBy={titleId}
                  onDone={() => collapse(s.type)}
                  onDelete={
                    s.custom
                      ? () => {
                          if (!window.confirm(`Delete "${s.label}"? This removes it immediately.`))
                            return;
                          void removeService(s.type).then(() => setExpanded(null));
                        }
                      : undefined
                  }
                />
              )}
            </Fragment>
          );
        })}
      </div>
      <div className="pb-service">
        <h3>Add service</h3>
        <AddServiceForm templates={settings.templates} addService={addService} />
      </div>
    </>
  );
}
