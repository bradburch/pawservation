import { describe, expect, it } from 'vitest';
import { SERVICE_PRESETS } from '../../app/admin/presets';
import { SERVICE_TEMPLATES, slugifyServiceLabel } from '../lib/services';

/**
 * The wizard's one-tap presets create a service by POSTing `{ template, label }` — the SERVER
 * derives the slug from the label (slugifyServiceLabel). `createdSlug` is the client's prediction
 * of that slug, used on the "already exists" retry path, and `matchTypes` is how a re-run
 * recognises a service the tenant already has. Renaming a preset's label therefore silently
 * breaks both unless the slug is recomputed and the OLD slug is kept as a match — this file is
 * the test that fails instead.
 */
describe('service presets', () => {
  it('createdSlug is exactly what the server derives from the label', () => {
    for (const p of SERVICE_PRESETS) {
      expect(p.createdSlug, p.label).toBe(slugifyServiceLabel(p.label));
    }
  });

  it('matchTypes always contains createdSlug, so a re-run recognises what it just created', () => {
    for (const p of SERVICE_PRESETS) {
      expect(p.matchTypes, p.label).toContain(p.createdSlug);
    }
  });

  it('keeps the pre-rename slugs matchable so an existing service is never duplicated', () => {
    const matches = (id: string) => SERVICE_PRESETS.find((p) => p.id === id)!.matchTypes;
    // The retired "Multiple Pack Walks" preset folded into the single pack-walks tile — its slugs
    // stay matchable there so an existing service is recognised rather than duplicated.
    expect(matches('pack-walks')).toEqual(
      expect.arrayContaining(['pack-walks', 'multi-pack-walks', 'multiple-pack-walks']),
    );
    expect(matches('solo-walker')).toEqual(expect.arrayContaining(['solo-walker', 'solo-walks']));
    expect(matches('daycare')).toEqual(expect.arrayContaining(['daycare', 'day-care']));
    expect(matches('checkin')).toEqual(
      expect.arrayContaining(['checkin', 'check-ins', 'check-in']),
    );
  });

  it('carries the user-facing names verbatim (plural walk names are deliberate)', () => {
    const label = (id: string) => SERVICE_PRESETS.find((p) => p.id === id)!.label;
    expect(label('pack-walks')).toBe('Pack Walks');
    expect(label('solo-walker')).toBe('Solo Walks');
    expect(label('daycare')).toBe('Daycare');
    expect(label('checkin')).toBe('Check-in');
  });

  it('offers exactly one pack-walk tile — a second daily pack is an OPTION, not a preset', () => {
    expect(SERVICE_PRESETS.filter((p) => p.id.endsWith('pack-walks')).map((p) => p.id)).toEqual([
      'pack-walks',
    ]);
  });

  it('names a template that exists, so the create POST can never 400 on "Unknown template."', () => {
    for (const p of SERVICE_PRESETS) {
      expect(SERVICE_TEMPLATES[p.template], p.label).toBeDefined();
    }
  });
});
