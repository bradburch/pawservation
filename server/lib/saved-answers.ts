import { questionShape, validateAnswer, type ServiceQuestion } from '../../src/shared/index.js';
import type { SavedAnswerRow } from '../db/repo.js';

/** `{ serviceType: { questionId: value } }` — what the widget pre-fills its intake form with. */
export type SavedAnswerMap = Record<string, Record<string, string>>;

/**
 * Turns stored rows into the pre-fill the widget may show, dropping anything that no longer
 * answers the question it was given to. TWO independent gates, and both matter:
 *
 *  1. **Shape** — the question's `questionShape()` must still match the one stored with the
 *     answer. This is the gate that catches a sitter REWORDING or RETYPING a question while
 *     keeping its id: "Feeding routine" becoming "Emergency vet phone number" would otherwise
 *     pre-fill "7am and 6pm, one cup" and validate perfectly.
 *  2. **Validity** — the value must still pass `validateAnswer` against the question AS IT IS
 *     NOW. This is the gate that catches a constraint change the shape deliberately ignores: a
 *     `select` whose options no longer include the saved choice, a `number` whose min/max moved.
 *
 * A question the service no longer asks is simply absent. Nothing here is authority: the pre-fill
 * is re-validated as an ordinary answer when the booking is submitted.
 */
export function buildSavedAnswerMap(
  rows: SavedAnswerRow[],
  services: { ServiceType: string; Questions: ServiceQuestion[] }[],
): SavedAnswerMap {
  const questionsByService = new Map(
    services.map((s) => [s.ServiceType, new Map(s.Questions.map((q) => [q.id, q]))]),
  );
  const map: SavedAnswerMap = {};
  for (const row of rows) {
    const question = questionsByService.get(row.ServiceType)?.get(row.QuestionId);
    if (!question) continue;
    if (questionShape(question) !== row.Shape) continue;
    if (validateAnswer(question, row.Value) !== null) continue;
    (map[row.ServiceType] ??= {})[row.QuestionId] = row.Value;
  }
  return map;
}

/**
 * What to persist after a booking lands: one entry per question the SERVICE asked, carrying the
 * trimmed value the customer submitted (`''` when they left it blank, which the repo turns into a
 * delete). Answers to keys this service never asked about are dropped — the widget can carry a
 * previous service's answers in its state, and they are not this service's to save.
 */
export function savedAnswerEntries(
  questions: ServiceQuestion[],
  answers: Record<string, string>,
): { questionId: string; shape: string; value: string }[] {
  return questions.map((q) => ({
    questionId: q.id,
    shape: questionShape(q),
    value: (answers[q.id] ?? '').trim(),
  }));
}
