import { Fragment, useEffect, useRef, useState } from 'react';
import { parseMixKey, petCountOf } from '../../../src/shared/index.js';
import { api, type TenantConfig } from '../../shared-ui/api.js';
import { IconTag } from '../../shared-ui/icons';
import { Hint } from '../Hint';
import { AddServiceTile } from './AddServiceTile.js';
import { ServiceCard } from './ServiceCard.js';
import { ServiceEditor } from './ServiceEditor.js';
import type { ServiceForm, SettingsSectionProps } from '../shared.js';

/** Grid expansion key for the add tile ('__' cannot collide with service type slugs). */
const ADD_KEY = '__add';

/**
 * Premium-served "settings review" card. Entirely data-driven off `/config`'s published `premium`
 * block (server/routes/public.ts): renders only when `premium.assistant === true` and
 * `premium.origin` is a non-empty string, otherwise nothing — no gating logic beyond that, and no
 * knowledge of what the iframe's content is or does. On any fetch failure this renders nothing
 * (absence, not an error) rather than degrade the dashboard.
 *
 * The one shared address is the path template itself, a deployment-level constant like the origin.
 * Height auto-resize mirrors the booking widget's own protocol (app/embed/App.tsx /
 * public/embed.js): the embedded page posts `{ type: 'pawservation:resize', height: number }` and
 * this listener applies it after checking `event.origin` against the published premium origin —
 * there is at most one such iframe on the page, so `event.source` isn't needed to disambiguate.
 */
function SettingsReviewEmbed({ slug }: { slug: string }) {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [height, setHeight] = useState(240);

  useEffect(() => {
    let active = true;
    api
      .config(slug)
      .then((c) => active && setConfig(c))
      .catch(() => {
        /* absence, not an error — the section just renders without this card */
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const origin = config?.premium?.assistant === true ? config.premium.origin : null;

  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = event.data as { type?: string; height?: number };
      if (data?.type === 'pawservation:resize' && typeof data.height === 'number') {
        setHeight(Math.max(120, Math.ceil(data.height)));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin]);

  if (!origin) return null;

  return (
    <iframe
      title="Settings review"
      src={`${origin}/premium/audit/${slug}`}
      style={{ width: '100%', border: '0', height: `${height}px` }}
    />
  );
}

export function ServicesSection({
  slug,
  settings,
  setSettings,
  addService,
  removeService,
  openWizard,
  dirty,
  saveBlocked,
  onSave,
  onFlashSavebar,
}: SettingsSectionProps & {
  slug: string;
  /** Resolves to the created service's type slug, or undefined if the POST failed. */
  addService: (template: string, label: string) => Promise<string | undefined>;
  removeService: (type: string) => Promise<void>;
  openWizard: () => void;
  /** True while the staged settings draft differs from the last save (App's `dirty`). */
  dirty: boolean;
  /** True while an unpriced option blocks saving (App hides the save bar's button too). */
  saveBlocked: boolean;
  /** The save bar's action, surfaced inline next to the content. */
  onSave: () => void;
  /** Pulses the fixed save bar so the sitter's eye lands on it. */
  onFlashSavebar: () => void;
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
  /**
   * Coarse spec-§6 check: the service can take 2+ pets (MaxPetCount null or >= 2) yet NO stored
   * rate — species-count with 2+ pets, or specific-pet group with 2+ pets — could price ANY
   * multi-pet set. Such bookings are refused server-side, so the card says so.
   *
   * A `linear` service has no such gap: an unpriced combination there is priced at the rate ×
   * the pet count, which is the sitter's own stored choice. The warning is for `exact` only —
   * leaving it up under `linear` would tell a sitter something is broken when nothing is.
   */
  const multiPetUnpriced = (s: ServiceForm): boolean =>
    s.enabled &&
    s.petRateMode === 'exact' &&
    (s.maxPetCount === null || s.maxPetCount >= 2) &&
    s.multiPetGroupRateCount === 0 &&
    !s.options.some((o) =>
      o.petRates.some((r) => r.mixKey !== '' && petCountOf(parseMixKey(r.mixKey)) >= 2),
    );

  return (
    <>
      <h2>
        <IconTag size={18} /> Services &amp; Rates
        <Hint label="Services & Rates">
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
        it as an option under Walk or Check-in with its own name, length, and price.
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
                multiPetUnpriced={multiPetUnpriced(s)}
              />
              {expanded === s.type && (
                <ServiceEditor
                  service={s}
                  setService={setService}
                  id={editorId}
                  labelledBy={titleId}
                  petTypes={settings.petTypes}
                  onDone={() => collapse(s.type)}
                  dirty={dirty}
                  saveBlocked={saveBlocked}
                  onSave={onSave}
                  onFlashSavebar={onFlashSavebar}
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
          // A fresh service is created disabled, unpriced and unconfigured, so drop the sitter
          // straight into its editor. `expanded` holds one key at a time, so pointing it at the
          // new service also collapses the add form.
          addService={async (template, label) => {
            const type = await addService(template, label);
            if (type) setExpanded(type);
            return type; // undefined on failure — the tile keeps the typed name for a retry
          }}
          expanded={expanded === ADD_KEY}
          onToggleExpanded={() => toggle(ADD_KEY)}
          openRef={(el) => openRefs.current.set(ADD_KEY, el)}
          atCap={settings.services.length >= 6}
        />
      </div>
      <SettingsReviewEmbed slug={slug} />
    </>
  );
}
