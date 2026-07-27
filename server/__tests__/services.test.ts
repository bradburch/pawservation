import { describe, expect, it } from 'vitest';
import { SERVICE_TEMPLATES as SHARED_TEMPLATES } from '../../src/shared/index.js';
import {
  SERVICE_TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  slugifyServiceLabel,
} from '../lib/services';

describe('service templates', () => {
  it('lists all five templates with a shape and rate unit', () => {
    expect(TEMPLATE_IDS).toEqual(['boarding', 'housesitting', 'daycare', 'walk', 'checkin']);
    expect(SERVICE_TEMPLATES.boarding.shape).toBe('range');
    expect(SERVICE_TEMPLATES.walk.shape).toBe('single');
    expect(SERVICE_TEMPLATES.daycare.rateUnit).toBe('day');
    expect(SERVICE_TEMPLATES.walk.hasDuration).toBe(true);
    expect(SERVICE_TEMPLATES.boarding.hasDuration).toBe(false);
  });

  it('prices walks per WALK and check-ins per visit', () => {
    // The unit is printed verbatim wherever a rate is shown, so 'walk' is a stored value, not a
    // display-time substitution on 'visit' (see migration 0024 + the schema CHECKs).
    expect(SERVICE_TEMPLATES.walk.rateUnit).toBe('walk');
    expect(SERVICE_TEMPLATES.checkin.rateUnit).toBe('visit');
  });

  it('names services in the singular the sitter reads in Services & rates', () => {
    expect(SERVICE_TEMPLATES.daycare.label).toBe('Daycare');
    expect(SERVICE_TEMPLATES.walk.label).toBe('Walk');
    expect(SERVICE_TEMPLATES.checkin.label).toBe('Check-in');
  });

  it('pins each template to a capacity pool', () => {
    expect(SERVICE_TEMPLATES.boarding.capacityKind).toBe('boarding');
    expect(SERVICE_TEMPLATES.housesitting.capacityKind).toBe('housesit');
    expect(SERVICE_TEMPLATES.walk.capacityKind).toBe('none');
  });

  it('guards membership', () => {
    expect(isTemplateId('walk')).toBe(true);
    expect(isTemplateId('teleport')).toBe(false);
  });
});

/** `rateUnit` used to be stated twice — once here (the unit the server stamps onto a created
 * TenantServices row) and again in the admin wizard, agreeing only by hand. The wizard now reads
 * SERVICE_TEMPLATES directly; this assertion fails if the server's re-export is ever replaced by a
 * hand-copied object, which the type system would not catch. */
describe('rateUnit has one source', () => {
  it("the server's SERVICE_TEMPLATES is the shared object, not a copy", () => {
    expect(SERVICE_TEMPLATES).toBe(SHARED_TEMPLATES);
  });
});

describe('slugifyServiceLabel', () => {
  it('derives slugs from labels', () => {
    expect(slugifyServiceLabel('Morning Walk!')).toBe('morning-walk');
    expect(slugifyServiceLabel('  Café & Cuddles  ')).toBe('caf-cuddles');
  });

  it('returns empty for labels with no derivable identity', () => {
    expect(slugifyServiceLabel('---')).toBe('');
    expect(slugifyServiceLabel('!!!')).toBe('');
  });
});
