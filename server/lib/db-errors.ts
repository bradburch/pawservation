/** True when err (or its D1-wrapped cause) is a SQLite UNIQUE constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  const hit = (e: unknown) => e instanceof Error && e.message.includes('UNIQUE constraint failed');
  return hit(err) || (err instanceof Error && hit(err.cause));
}
