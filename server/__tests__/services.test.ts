import { describe, expect, it } from 'vitest';
import {
  PET_TYPES,
  SERVICE_CATALOG,
  SERVICE_TYPES,
  isPetType,
  isServiceType,
} from '../lib/services';

describe('service catalog', () => {
  it('lists all five services with a shape and rate unit', () => {
    expect(SERVICE_TYPES).toEqual(['boarding', 'housesitting', 'daycare', 'walk', 'checkin']);
    expect(SERVICE_CATALOG.boarding.shape).toBe('range');
    expect(SERVICE_CATALOG.walk.shape).toBe('single');
    expect(SERVICE_CATALOG.daycare.rateUnit).toBe('day');
    expect(SERVICE_CATALOG.walk.hasDuration).toBe(true);
    expect(SERVICE_CATALOG.boarding.hasDuration).toBe(false);
  });

  it('guards membership', () => {
    expect(isServiceType('walk')).toBe(true);
    expect(isServiceType('teleport')).toBe(false);
    expect(isPetType('dog')).toBe(true);
    expect(isPetType('dragon')).toBe(false);
  });

  it('exposes exactly dog and cat as pet types', () => {
    expect(PET_TYPES).toEqual(['dog', 'cat']);
  });
});
