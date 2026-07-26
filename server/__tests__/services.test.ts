import { describe, expect, it } from 'vitest';
import { SERVICE_PRESETS } from '../../app/admin/presets.js';
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
 * TenantServices row) and again per entry in the admin wizard's SERVICE_PRESETS, agreeing only by
 * hand. These assertions fail if either copy comes back. */
describe('rateUnit has one source', () => {
  it("the server's SERVICE_TEMPLATES is the shared object, not a copy", () => {
    expect(SERVICE_TEMPLATES).toBe(SHARED_TEMPLATES);
  });

  it('every wizard preset shows its template’s rate unit', () => {
    expect(SERVICE_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SERVICE_PRESETS) {
      expect(preset.rateUnit).toBe(SERVICE_TEMPLATES[preset.template].rateUnit);
    }
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
