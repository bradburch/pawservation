import { serviceSummary } from '../../../src/shared/index.js';
import { IconPaw, SERVICE_ICONS } from '../../shared-ui/icons';
import type { ServiceForm } from '../shared.js';

function ServiceIcon({ icon }: { icon: string }) {
  const Icon = SERVICE_ICONS[icon] ?? IconPaw;
  return <Icon size={16} />;
}

/**
 * One summary card in the Services & rates grid: an enable switch and an expand
 * button as SIBLINGS (never nested — valid HTML, clean a11y). The card's facts are
 * plain text inside the expand button, so its accessible name reads name + price +
 * facts. Spec: docs/superpowers/specs/2026-07-19-services-rates-redesign.md.
 */
export function ServiceCard({
  service,
  expanded,
  editorId,
  titleId,
  onToggleEnabled,
  onToggleExpanded,
  openRef,
  acceptedPetLabels,
}: {
  service: ServiceForm;
  expanded: boolean;
  editorId: string;
  titleId: string;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleExpanded: () => void;
  openRef: (el: HTMLButtonElement | null) => void;
  acceptedPetLabels: string[] | null;
}) {
  const { price, facts } = serviceSummary({ ...service, acceptedPetLabels });
  const cardClass =
    'pb-tile-btn pb-svc-card' +
    (service.enabled ? ' pb-on' : '') +
    (expanded ? ' pb-svc-expanded' : '');
  return (
    <div className={cardClass}>
      <input
        type="checkbox"
        className="pb-svc-switch"
        checked={service.enabled}
        aria-label={`Offer ${service.label}`}
        onChange={(e) => onToggleEnabled(e.target.checked)}
      />
      <button
        type="button"
        className="pb-svc-open"
        aria-expanded={expanded}
        aria-controls={expanded ? editorId : undefined}
        onClick={onToggleExpanded}
        ref={openRef}
      >
        <span className="pb-svc-title" id={titleId}>
          <ServiceIcon icon={service.icon} />
          <strong className="pb-truncate">{service.label}</strong>
          {service.custom && <span className="pb-chip">Custom</span>}
        </span>
        <span className={`pb-svc-price${service.options.length === 0 ? ' pb-svc-price-soft' : ''}`}>
          {price}
        </span>
        {service.enabled ? (
          facts && <span className="pb-hint">{facts}</span>
        ) : (
          <span className="pb-hint">Not offered — turn on to take bookings</span>
        )}
      </button>
    </div>
  );
}
