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
  pattern?: string; // type: 'text', optional regex source
  options?: string[]; // type: 'select'
};

export type ServiceConstraints = {
  minNights: number | null;
  maxNights: number | null;
  minPetCount: number | null;
  maxPetCount: number | null;
};

/** Safety rail (NOT a business rule): bounds regex-evaluation cost against a pathological
 * pattern that slipped past admin-time validation. Intake answers are short by nature. */
const MAX_PATTERN_INPUT_LENGTH = 100;

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
      if (question.pattern) {
        if (trimmed.length > MAX_PATTERN_INPUT_LENGTH) return `${question.label} is too long.`;
        if (!new RegExp(question.pattern).test(trimmed))
          return `${question.label} is not in the expected format.`;
      }
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
  if (nights !== null) {
    if (constraints.minNights !== null && nights < constraints.minNights)
      return `This service requires at least ${constraints.minNights} night${constraints.minNights === 1 ? '' : 's'}.`;
    if (constraints.maxNights !== null && nights > constraints.maxNights)
      return `This service allows at most ${constraints.maxNights} night${constraints.maxNights === 1 ? '' : 's'}.`;
  }
  if (constraints.minPetCount !== null && petCount < constraints.minPetCount)
    return `This service requires at least ${constraints.minPetCount} pet${constraints.minPetCount === 1 ? '' : 's'}.`;
  if (constraints.maxPetCount !== null && petCount > constraints.maxPetCount)
    return `This service allows at most ${constraints.maxPetCount} pet${constraints.maxPetCount === 1 ? '' : 's'}.`;
  return null;
}
