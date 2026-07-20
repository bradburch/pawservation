import { describe, expect, it } from 'vitest';
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
