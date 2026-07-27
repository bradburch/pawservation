import type { ReactNode } from 'react';

/** A nullable capacity/limit input: blank ⇒ null (no limit), a number ⇒ that value. */
export function NullableNumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  /** Optional `?` toggletip rendered INLINE right after the label text (a11y: the icon
   * belongs to the words it explains, not floating under the input). */
  hint?: ReactNode;
}) {
  // Blank (null) is VALID — it means "no limit". A held value must be a whole number ≥ 1;
  // aria-invalid drives the shared red-border/ring CSS in admin.css.
  const invalid = value !== null && (!Number.isInteger(value) || value <= 0);
  return (
    <label>
      <span className="pb-labelrow">
        {label} <span className="pb-hint">(blank = no limit)</span>
        {hint}
      </span>
      <input
        type="number"
        min={1}
        aria-invalid={invalid}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </label>
  );
}
