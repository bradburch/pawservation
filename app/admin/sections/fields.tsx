import type { KeyboardEvent, ReactNode } from 'react';

/**
 * Parse a number input's raw string into the field's OWN valid range.
 *
 * `<input type="number" min=…>` is advisory only — the browser flags a bad value but still reports
 * it through `onChange`, so `Number(e.target.value)` used to put `-3` (or `2.5`) straight into
 * state and into the settings PUT, where the server answered with a raw 400. Clamping here is the
 * inline prevention: the bounds come from the caller's own `min`/`max`, never from a hardcoded
 * assumption about what any particular field means.
 *
 * - blank ⇒ `null` (every caller's "no limit")
 * - unparseable (a lone `-`, `e`) ⇒ the value already held, so a keystroke can never write `NaN`
 * - a whole-number `step` ⇒ the value is truncated, so a decimal can't reach state either
 */
export function clampNullableNumber(
  raw: string,
  {
    min,
    max,
    step = 1,
    current,
  }: { min: number; max?: number; step?: number; current: number | null },
): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return current;
  const stepped = Number.isInteger(step) ? Math.trunc(parsed) : parsed;
  if (stepped < min) return min;
  if (max !== undefined && stepped > max) return max;
  return stepped;
}

/**
 * Keydown guard for a number field that can never hold a negative value (`min >= 0`): swallow the
 * sign and exponent keys outright, so the sitter never sees a `-` appear at all. Fields that DO
 * admit negatives (none today) pass a negative `min` and keep every key.
 */
export function blockNegativeNumberKeys(min: number) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (min >= 0 && (e.key === '-' || e.key === '+' || e.key === 'e' || e.key === 'E'))
      e.preventDefault();
  };
}

/** A nullable capacity/limit input: blank ⇒ null (no limit), a number ⇒ that value.
 *
 * `min` defaults to `1` (every current caller's floor is 1), and `clampNullableNumber` clamps a
 * typed value UP to it — so a future field where `0` is a meaningful, distinct value MUST pass
 * `min={0}` explicitly, or `0` silently becomes untypeable (every keystroke clamps it back to 1). */
export function NullableNumberField({
  label,
  value,
  onChange,
  hint,
  min = 1,
  max,
  step = 1,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  /** Optional `?` toggletip rendered INLINE right after the label text (a11y: the icon
   * belongs to the words it explains, not floating under the input). */
  hint?: ReactNode;
  /** Lowest value this particular field accepts — also what a typed value is clamped UP to. */
  min?: number;
  /** Highest value this field accepts, when it has one; absent = unbounded above. */
  max?: number;
  /** Whole-number step (the default) also means "no decimals reach state". */
  step?: number;
}) {
  // Blank (null) is VALID — it means "no limit". A held value must be a whole number within the
  // field's own bounds; aria-invalid drives the shared red-border/ring CSS in admin.css.
  const invalid =
    value !== null &&
    (!Number.isInteger(value) || value < min || (max !== undefined && value > max));
  return (
    <label>
      <span className="pb-labelrow">
        {label} <span className="pb-hint">(blank = no limit)</span>
        {hint}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        aria-invalid={invalid}
        // Explicit name: without it the accessible name is computed from the whole label's
        // contents, which includes the Hint toggletip's entire prose.
        aria-label={`${label} (blank = no limit)`}
        value={value ?? ''}
        onKeyDown={blockNegativeNumberKeys(min)}
        onChange={(e) =>
          onChange(clampNullableNumber(e.target.value, { min, max, step, current: value }))
        }
      />
    </label>
  );
}
