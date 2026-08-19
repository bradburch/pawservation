/** True when err (or its D1-wrapped cause) is a SQLite UNIQUE constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  const hit = (e: unknown) => e instanceof Error && e.message.includes('UNIQUE constraint failed');
  return hit(err) || (err instanceof Error && hit(err.cause));
}

/**
 * True when err (or its D1-wrapped cause) is SQLite refusing a NULL `Payments.Amount`.
 *
 * That is not an ordinary fault: it is how attribution's in-batch guards REPORT a lost race.
 * `applyAttribution` (server/db/repo.ts) multiplies a split's amount by scalar subqueries over the
 * source row and the target booking's live outstanding, so a stale read yields NULL, `INTEGER NOT
 * NULL` refuses the INSERT, and the whole batch rolls back. The guard rests on the column being
 * NOT NULL rather than on a CHECK, because SQLite treats a CHECK over NULL as PASSING.
 *
 * Deliberately narrow — it names the one column whose NULL means this. An unrecognised message
 * falls through to a rethrow, which the apply route reports as a fault rather than a refusal, so a
 * wording change upstream degrades to "logged as unexpected" and never to "quietly written".
 */
export function isNotNullViolation(err: unknown): boolean {
  const hit = (e: unknown) =>
    e instanceof Error && e.message.includes('NOT NULL constraint failed: Payments.Amount');
  return hit(err) || (err instanceof Error && hit(err.cause));
}
