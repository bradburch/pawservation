import { type ServiceQuestion } from '../shared-ui/api';

export function QuestionField({
  question,
  value,
  onChange,
}: {
  question: ServiceQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = `${question.label}${question.required ? ' *' : ''}`;
  if (question.type === 'yesno') {
    return (
      <label className="bp-field">
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    );
  }
  if (question.type === 'select') {
    return (
      <label className="bp-field">
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(question.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="bp-field">
      {label}
      <input
        type={question.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
