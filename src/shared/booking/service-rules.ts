// Per-service intake questions + booking-level constraints. Pure, zero-dependency —
// shared between the widget (inline feedback) and the server (authoritative check).

export type QuestionType = 'text' | 'yesno' | 'number' | 'select';

export type ServiceQuestion = {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  min?: number; // type: 'number'
  max?: number; // type: 'number'
  options?: string[]; // type: 'select'
};
// NOTE: text questions once carried an optional `pattern` (regex) — retired. Old stored
// Questions JSON may still hold a `pattern` key; it parses fine and is simply ignored.

/**
 * Label normalized for IDENTITY comparison only (never for display): case, punctuation and
 * spacing are cosmetic, the words are the question. So "Vet's phone number?" and
 * "vet s phone number" are the same question, while "Emergency contact" is not.
 */
function normalizeQuestionLabel(label: string): string {
  return (
    label
      .toLowerCase()
      // Apostrophes are DELETED rather than treated as a separator, so that adding or fixing one
      // — the single most common cosmetic label edit — keeps "Vets phone" and "Vet's phone" one
      // question. Every other punctuation mark separates.
      .replace(/['‘’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

/**
 * What a question IS, for the purpose of deciding whether an answer given to it earlier still
 * answers it — the guard on saved intake answers (see `SavedAnswers` in sql/schema.sql). A
 * question's `id` is stable across sitter edits (the admin editor mints one UUID per row and the
 * server preserves it), so the id alone would happily pre-fill "Bella eats at 7am" against a
 * question relabelled "Emergency vet phone number". The shape is what catches that.
 *
 * Deliberately just `type` + normalized `label`:
 *  - a RENAME (real rewording) or a RETYPE means a different question — the saved answer is
 *    dropped rather than re-offered;
 *  - `options`, `min`, `max` and `required` are NOT included, because they are constraints on the
 *    answer rather than a change to what is being asked, and `validateAnswer` already refuses a
 *    saved value that no longer satisfies them. Including them would wipe every customer's saved
 *    entry method just because the sitter added a fourth way to get in.
 *
 * If a field is ever added to `ServiceQuestion`, decide here whether it changes the question.
 */
export function questionShape(question: ServiceQuestion): string {
  return `${question.type}|${normalizeQuestionLabel(question.label)}`;
}

export type ServiceConstraints = {
  maxNights: number | null;
  maxPetCount: number | null;
};

/** A priced, bookable slot within a service (e.g. a duration tier or a fixed time window).
 * Field-level shape shared by the widget config, the admin form, and the admin settings wire
 * format — see app/shared-ui/api.ts and app/admin/shared.ts for how each extends this. */
export type ServiceOption = {
  optionKey: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
  startTime: string | null; // 'HH:MM'; null = no fixed window
  endTime: string | null; // 'HH:MM'; null = no fixed window
  capacity: number | null; // max concurrent bookings/date; null = unlimited
  weekdaysOnly: boolean; // true = bookable Mon–Fri only (server rejects Sat/Sun; widget marks weekends unavailable)
};

/** Validates one answer against its question. Returns an error message, or null if valid. */
export function validateAnswer(
  question: ServiceQuestion,
  value: string | undefined,
): string | null {
  const trimmed = value?.trim() ?? '';
  if (question.required && trimmed === '') return `${question.label} is required.`;
  if (trimmed === '') return null; // optional and empty — nothing else to check

  switch (question.type) {
    case 'yesno':
      if (trimmed !== 'yes' && trimmed !== 'no') return `${question.label} must be yes or no.`;
      return null;
    case 'number': {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return `${question.label} must be a number.`;
      if (question.min !== undefined && n < question.min)
        return `${question.label} must be at least ${question.min}.`;
      if (question.max !== undefined && n > question.max)
        return `${question.label} must be at most ${question.max}.`;
      return null;
    }
    case 'select':
      if (!(question.options ?? []).includes(trimmed))
        return `${question.label} must be one of the listed options.`;
      return null;
    case 'text':
    default:
      return null;
  }
}

/** Validates a full answer set against a service's questions. Returns the first error, or null. */
export function validateAnswers(
  questions: ServiceQuestion[],
  answers: Record<string, string>,
): string | null {
  for (const q of questions) {
    const error = validateAnswer(q, answers[q.id]);
    if (error) return error;
  }
  return null;
}

/** Validates booking-level constraints. `nights` is null for non-range (single-day) services. */
export function validateServiceConstraints(
  constraints: ServiceConstraints,
  booking: { nights: number | null; petCount: number },
): string | null {
  const { nights, petCount } = booking;
  // There is deliberately no minimum-nights constraint: the minimum stay is structurally 1.
  if (nights !== null) {
    if (constraints.maxNights !== null && nights > constraints.maxNights)
      return `This service allows at most ${constraints.maxNights} night${constraints.maxNights === 1 ? '' : 's'}.`;
  }
  if (constraints.maxPetCount !== null && petCount > constraints.maxPetCount)
    return `This service allows at most ${constraints.maxPetCount} pet${constraints.maxPetCount === 1 ? '' : 's'}.`;
  return null;
}

/**
 * Per-service pet-type acceptance. `accepted` null = the service accepts every REGISTRY type
 * (the codebase's null-is-unlimited convention); an array is an explicit allow-list of
 * pet-type slugs. This is the single behavioral gate — the retired tenant-level enabled switch
 * no longer exists. Checks EVERY selected pet and returns the first error, or null.
 * `labelOf` maps a slug to its tenant display label — callers fall back to the raw slug
 * (`(s) => labels.get(s) ?? s`).
 */
export function validatePetTypeAcceptance(
  accepted: string[] | null,
  serviceLabel: string,
  pets: { name: string; petType: string }[],
  labelOf: (slug: string) => string,
): string | null {
  if (accepted === null) return null;
  for (const pet of pets) {
    if (!accepted.includes(pet.petType)) {
      // Registry labels are singular ("Cat"), so pluralize for the sentence — naive add-s is
      // right for every seeded label (cats, dogs, birds); a label already ending in s keeps it.
      const label = labelOf(pet.petType).toLowerCase();
      const plural = label.endsWith('s') ? label : `${label}s`;
      return `${serviceLabel} doesn't accept ${plural} — ${pet.name} can't join this booking.`;
    }
  }
  return null;
}
