import { Fragment, useRef, useState } from 'react';
import { IconTag } from '../../shared-ui/icons';
import { Hint } from '../Hint';
import { AddServiceTile } from './AddServiceTile.js';
import { ServiceCard } from './ServiceCard.js';
import { ServiceEditor } from './ServiceEditor.js';
import type { ServiceForm, SettingsSectionProps } from '../shared.js';

/** Grid expansion key for the add tile ('__' cannot collide with service type slugs). */
const ADD_KEY = '__add';

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
  // Which editor is open: a service type, ADD_KEY, or null. One at a time —
  // expanding another collapses the first. Collapsing never loses edits: all
  // field state lives in the staged settings draft; the save bar is the single
  // source of truth for unsaved changes. Local state, unaddressed by #services.
  const [expanded, setExpanded] = useState<string | null>(null);
  // Done returns focus to the tapped card's expand button.
  const openRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const toggle = (key: string) => setExpanded((cur) => (cur === key ? null : key));
  const collapse = (key: string) => {
    setExpanded(null);
    openRefs.current.get(key)?.focus();
  };

  const labelBySlug = new Map(settings.petTypes.map((p) => [p.petType, p.label]));

  return (
    <>
      <h2>
        <IconTag size={18} /> Services &amp; rates
        <Hint label="Services & rates">
          Each card is one thing clients can book, with its price and rules at a glance. Tap a card
          to edit pricing, questions, and limits; use its switch to offer or pause it.
        </Hint>
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
                acceptedPetLabels={s.acceptedPetTypes?.map((t) => labelBySlug.get(t) ?? t) ?? null}
              />
              {expanded === s.type && (
                <ServiceEditor
                  service={s}
                  setService={setService}
                  id={editorId}
                  labelledBy={titleId}
                  petTypes={settings.petTypes}
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
        {settings.services.length === 0 && (
          <div className="pb-tile-btn pb-svc-empty">
            No services yet — run Quick setup or add one below.
          </div>
        )}
        <AddServiceTile
          templates={settings.templates}
          addService={addService}
          expanded={expanded === ADD_KEY}
          onToggleExpanded={() => toggle(ADD_KEY)}
          openRef={(el) => openRefs.current.set(ADD_KEY, el)}
          atCap={settings.services.length >= 6}
        />
      </div>
    </>
  );
}
