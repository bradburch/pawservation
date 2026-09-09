/**
 * WHAT A SOURCE-PIN ASSERTION IS ALLOWED TO SEE.
 *
 * Several tests in this suite pin a promise at its own source — there is no DOM harness for the
 * admin bundle, and properties like "compares in constant time" are properties of the code rather
 * than of any response. A pin like that is only worth its line if the text it matches is text that
 * RUNS. Three mutation probes survived by deleting the real code and leaving the pinned string
 * behind in a comment, including the owner-console chip regression a test is named for.
 *
 * So: comments always go, and by default so do string and template literals. A literal is not
 * executable structure either — `const gate = 'premium?.origin'` satisfies a naive `toContain`
 * exactly as a comment does — and dropping them is also what keeps the AD-13 scanner from
 * reporting the SQL in `repo.ts` and the `UPDATE Tenants SET PremiumUntil = …` fixtures in this
 * suite, both of which name the columns it hunts for.
 *
 * `keepLiterals` is for the pins whose SUBJECT is a literal: an import path, `method: 'POST'`, the
 * template literal the checkout URL is built from. Stripping those would make the assertion
 * unsatisfiable rather than stricter. Comments are still removed, which is the evasion those pins
 * were actually losing to.
 *
 * Deliberately not a parser. `//` inside a string is truncated as if it were a comment (a `://` is
 * excepted, so URLs survive), and a backtick inside a quoted string will confuse it. Both are
 * cheaper than a TypeScript AST for a handful of assertions, and neither is reachable from the
 * files this is pointed at.
 */
export function liveSource(text: string, opts: { keepLiterals?: boolean } = {}): string {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (opts.keepLiterals) return code;
  return code
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
