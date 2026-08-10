import { describe, expect, it } from 'vitest';
import { parseEventSummary, resolvePetsByName } from '../lib/calendar-backfill';

describe('parseEventSummary', () => {
  it('splits one pet and a service word', () => {
    expect(parseEventSummary('Sadie Walk')).toEqual({
      petNames: ['Sadie'],
      serviceHint: 'walk',
      cancelled: false,
    });
  });

  it('splits pets joined by "and"', () => {
    expect(parseEventSummary('Pedro and Remy')).toEqual({
      petNames: ['Pedro', 'Remy'],
      serviceHint: null,
      cancelled: false,
    });
  });

  it('reads a trailing CANCELLED marker and drops it from the names', () => {
    expect(parseEventSummary('Summer and Chia Walk - CANCELLED')).toEqual({
      petNames: ['Summer', 'Chia'],
      serviceHint: 'walk',
      cancelled: true,
    });
  });

  it("reads pawservation's own leading [CANCELLED] marker", () => {
    expect(parseEventSummary('[CANCELLED] Bella — Boarding')).toEqual({
      petNames: ['Bella'],
      serviceHint: 'boarding',
      cancelled: true,
    });
  });

  it('treats a [REQUEST] marker as not cancelled', () => {
    expect(parseEventSummary('[REQUEST] Bella — Boarding').cancelled).toBe(false);
  });

  it('returns no names for an empty summary', () => {
    expect(parseEventSummary('')).toEqual({ petNames: [], serviceHint: null, cancelled: false });
  });

  it('does not read a service word out of the middle of a pet name', () => {
    expect(parseEventSummary('Walker')).toEqual({
      petNames: ['Walker'],
      serviceHint: null,
      cancelled: false,
    });
  });

  it('leaves a non-service title as a single unmatched name', () => {
    // "Brad Unavailable" is a real title from the sitter's calendar. It names no service and no
    // known pet; it must survive parsing intact so the pet resolver can flag it, not vanish here.
    expect(parseEventSummary('Brad Unavailable')).toEqual({
      petNames: ['Brad Unavailable'],
      serviceHint: null,
      cancelled: false,
    });
  });
});

const PETS = [
  { id: 'p1', name: 'Sadie', petType: 'dog' },
  { id: 'p2', name: 'Remy', petType: 'dog' },
  { id: 'p3', name: 'Bella', petType: 'cat' },
  { id: 'p4', name: 'Bella', petType: 'dog' }, // a SECOND Bella — the ambiguity case
];

describe('resolvePetsByName', () => {
  it('resolves a single unambiguous name, case-insensitively', () => {
    expect(resolvePetsByName(['sadie'], PETS)).toEqual({
      ok: true,
      pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
    });
  });

  it('resolves several names', () => {
    const out = resolvePetsByName(['Sadie', 'Remy'], PETS);
    expect(out.ok).toBe(true);
    expect(out.ok && out.pets.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('REFUSES a name matching two pets rather than picking one', () => {
    expect(resolvePetsByName(['Bella'], PETS)).toEqual({
      ok: false,
      reason: 'ambiguous-pet',
      detail: 'Bella matches 2 pets',
    });
  });

  it('reports no-pets when nothing matches', () => {
    expect(resolvePetsByName(['Nobody'], PETS)).toEqual({
      ok: false,
      reason: 'no-pets',
      detail: 'No pet named Nobody',
    });
  });

  it('reports no-pets for an empty name list', () => {
    expect(resolvePetsByName([], PETS)).toEqual({
      ok: false,
      reason: 'no-pets',
      detail: 'No pet names in the title',
    });
  });

  it('reports the ambiguity even when another name resolved fine', () => {
    expect(resolvePetsByName(['Sadie', 'Bella'], PETS).ok).toBe(false);
  });

  it('counts a co-owned pet once, not as an ambiguity', () => {
    // listAllEndUserPetsByTenant JOINs PetOwners, so a pet with two owners arrives TWICE with the
    // same id. That is one animal, not two — it must resolve, not flag.
    const coOwned = [
      { id: 'p1', name: 'Sadie', petType: 'dog' },
      { id: 'p1', name: 'Sadie', petType: 'dog' },
    ];
    expect(resolvePetsByName(['Sadie'], coOwned)).toEqual({
      ok: true,
      pets: [{ id: 'p1', name: 'Sadie', petType: 'dog' }],
    });
  });

  it('still refuses two DIFFERENT pets that share a name', () => {
    const twins = [
      { id: 'p1', name: 'Bella', petType: 'cat' },
      { id: 'p2', name: 'Bella', petType: 'dog' },
    ];
    expect(resolvePetsByName(['Bella'], twins)).toEqual({
      ok: false,
      reason: 'ambiguous-pet',
      detail: 'Bella matches 2 pets',
    });
  });
});
