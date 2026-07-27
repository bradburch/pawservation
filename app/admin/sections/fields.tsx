/** A nullable capacity/limit input: blank ⇒ null (no limit), a number ⇒ that value. */
export function NullableNumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  // Blank (null) is VALID — it means "no limit". A held value must be a whole number ≥ 1;
  // aria-invalid drives the shared red-border/ring CSS in admin.css.
  const invalid = value !== null && (!Number.isInteger(value) || value <= 0);
  return (
    <label>
      {label} <span className="pb-hint">(blank = no limit)</span>
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
