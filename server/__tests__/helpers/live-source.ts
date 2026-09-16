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
 * exactly as a comment does — and dropping them is also what keeps the one-expression scanner from
 * reporting the SQL in `repo.ts` and the `UPDATE Tenants SET PremiumUntil = …` fixtures in this
 * suite, both of which name the columns it hunts for.
 *
 * `keepLiterals` is for the pins whose SUBJECT is a literal: an import path, `method: 'POST'`, the
 * template literal the checkout URL is built from. Stripping those would make the assertion
 * unsatisfiable rather than stricter. Comments are still removed, which is the evasion those pins
 * were actually losing to.
 *
 * IT IS ONE PASS, AND IT HAS TO BE, because the two halves of the job decide each other: whether a
 * `//` opens a comment depends on whether it sits inside a literal, and whether a quote opens a
 * literal depends on whether it sits inside a comment. Two independent regexes — which is what this
 * was — get that wrong in the one direction nobody notices. `adminRoutes`' own
 * `.use('/:slug/admin/*', adminAuth)` read as the start of a block comment and swallowed 880 lines
 * of `server/routes/admin.ts`, the whole settings handler included, so every pin over that file and
 * the one-expression scanner itself were green over text they had never looked at.
 * `server/routes/owner.ts`, `server/lib/middleware.ts`, `server/index.ts` and
 * `server/routes/bookings.ts` each lost a span to a quoted route pattern of their own.
 *
 * Still deliberately not a TypeScript parser, and two limits are worth knowing rather than
 * discovering:
 *
 *   - **A `://` is not a comment**, so a URL written in ordinary code or in JSX text survives. That
 *     exception costs a character and predates the tokenizer; inside a literal it is now redundant.
 *   - **A regex literal is read as ordinary code**, so a comment marker written inside one still
 *     reads as a comment marker and a lone quote inside one still reads as a quote. The containment
 *     is that a single- or double-quoted literal must CLOSE ON ITS OWN LINE to count at all — so an
 *     apostrophe in prose, in JSX text or in a regex costs that line and never the file. A backtick
 *     has no such bound, which is the one shape that could still swallow a span.
 */
export function liveSource(text: string, opts: { keepLiterals?: boolean } = {}): string {
  const keep = opts.keepLiterals === true;
  let out = '';
  /**
   * Open contexts, innermost last. A template literal pushes `'tpl'`; a substitution inside one
   * pushes a `'code'` frame whose `sub` flag says that its unmatched `}` closes the substitution
   * rather than a block. Single- and double-quoted literals never nest and are read whole in place.
   */
  const frames: { kind: 'code' | 'tpl'; depth: number; sub: boolean }[] = [
    { kind: 'code', depth: 0, sub: false },
  ];
  /** How many template literals deep we are. In stripping mode everything inside the outermost one
   *  is suppressed, substitutions included — which is what the regex this replaced did, and what the
   *  pins written against it expect. */
  let templates = 0;
  const emit = (s: string) => {
    if (keep || templates === 0) out += s;
  };

  let i = 0;
  while (i < text.length) {
    const frame = frames[frames.length - 1];
    const c = text[i];
    const next = text[i + 1];

    if (frame.kind === 'tpl') {
      if (c === '\\') {
        emit(text.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        frames.pop();
        templates -= 1;
        if (keep || templates === 0) out += '`';
        i += 1;
      } else if (c === '$' && next === '{') {
        emit('${');
        frames.push({ kind: 'code', depth: 0, sub: true });
        i += 2;
      } else {
        emit(c);
        i += 1;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    // `text[i - 1]` rather than the last non-space character, which is what the regex this replaced
    // tested: a `://` is not a comment, and at the start of the file `undefined !== ':'` holds.
    if (c === '/' && next === '/' && text[i - 1] !== ':') {
      while (i < text.length && text[i] !== '\n') i += 1; // the newline itself is emitted next pass
      continue;
    }
    if (c === "'" || c === '"') {
      const end = closingQuote(text, i, c);
      if (end === -1) {
        // No partner before the line ends: an apostrophe in prose or in a regex, not a literal.
        emit(c);
        i += 1;
      } else {
        emit(keep ? text.slice(i, end + 1) : c + c);
        i = end + 1;
      }
      continue;
    }
    if (c === '`') {
      if (keep || templates === 0) out += '`';
      frames.push({ kind: 'tpl', depth: 0, sub: false });
      templates += 1;
      i += 1;
      continue;
    }
    if (c === '{') {
      frame.depth += 1;
    } else if (c === '}') {
      if (frame.sub && frame.depth === 0) {
        frames.pop();
        emit('}');
        i += 1;
        continue;
      }
      frame.depth -= 1;
    }
    emit(c);
    i += 1;
  }
  return out;
}

/** The index of the `quote` that closes the literal opening at `open`, or -1 if the line ends first
 *  — the bound that keeps a stray apostrophe from costing more than its own line. */
function closingQuote(text: string, open: number, quote: string): number {
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') i += 1;
    else if (c === '\n') return -1;
    else if (c === quote) return i;
  }
  return -1;
}
