import { NullableNumberField } from './BusinessSection.js';
import { IconTag } from '../../shared-ui/icons';
import type { QuestionForm, ServiceForm, SettingsSectionProps } from '../shared.js';

const QUESTION_TYPES: QuestionForm['type'][] = ['text', 'yesno', 'number', 'select'];
const QUESTION_TYPE_LABELS: Record<QuestionForm['type'], string> = {
  text: 'Text',
  yesno: 'Yes / No',
  number: 'Number',
  select: 'Single choice',
};

function emptyQuestion(): QuestionForm {
  // A client-assigned id (kept as-is by the server on save) gives new, unsaved questions a stable
  // React key — without it, reordering before the first save swaps DOM nodes by array index and
  // can jump focus to the wrong row.
  return { id: crypto.randomUUID(), label: '', type: 'text', required: false };
}

function QuestionRow({
  question,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  question: QuestionForm;
  onChange: (next: QuestionForm) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div className="pb-options">
      <div className="pb-inline">
        <input
          placeholder="Question"
          value={question.label}
          onChange={(e) => onChange({ ...question, label: e.target.value })}
        />
        <select
          value={question.type}
          onChange={(e) => onChange({ ...question, type: e.target.value as QuestionForm['type'] })}
        >
          {QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <label className="pb-inline">
          <input
            type="checkbox"
            checked={question.required}
            onChange={(e) => onChange({ ...question, required: e.target.checked })}
          />
          Required
        </label>
        {onMoveUp && (
          <button type="button" onClick={onMoveUp}>
            ↑
          </button>
        )}
        {onMoveDown && (
          <button type="button" onClick={onMoveDown}>
            ↓
          </button>
        )}
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      </div>
      {question.type === 'number' && (
        <div className="pb-inline">
          <input
            type="number"
            placeholder="min"
            value={question.min ?? ''}
            onChange={(e) =>
              onChange({
                ...question,
                min: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
          <input
            type="number"
            placeholder="max"
            value={question.max ?? ''}
            onChange={(e) =>
              onChange({
                ...question,
                max: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </div>
      )}
      {question.type === 'select' && (
        <input
          placeholder="Options, comma-separated"
          value={(question.options ?? []).join(', ')}
          onChange={(e) =>
            onChange({
              ...question,
              options: e.target.value
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean),
            })
          }
        />
      )}
      {question.type === 'text' && (
        <input
          placeholder="Optional pattern (regex, advanced)"
          value={question.pattern ?? ''}
          onChange={(e) => onChange({ ...question, pattern: e.target.value || undefined })}
        />
      )}
    </div>
  );
}

export function ServicesSection({ settings, setSettings }: SettingsSectionProps) {
  return (
    <>
      <h2>
        <IconTag size={18} /> Services &amp; rates
      </h2>
      {settings.services.map((s, si) => {
        const setService = (next: ServiceForm) => {
          const services = [...settings.services];
          services[si] = next;
          setSettings({ ...settings, services });
        };
        return (
          <div className="pb-service" key={s.type}>
            <label className="pb-inline">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => setService({ ...s, enabled: e.target.checked })}
              />
              {s.label}
            </label>
            {!s.hasDuration ? (
              <label className="pb-inline">
                $
                <input
                  type="number"
                  min={1}
                  value={s.options[0]?.rate ?? 0}
                  onChange={(e) =>
                    setService({
                      ...s,
                      options: [
                        {
                          label: 'Standard',
                          durationMinutes: null,
                          rate: Number(e.target.value),
                        },
                      ],
                    })
                  }
                />
                /{s.rateUnit}
              </label>
            ) : (
              <div className="pb-options">
                {s.options.map((o, oi) => (
                  <div className="pb-inline" key={oi}>
                    <input
                      type="number"
                      min={1}
                      placeholder="min"
                      value={o.durationMinutes ?? 0}
                      onChange={(e) => {
                        const options = [...s.options];
                        options[oi] = {
                          ...o,
                          durationMinutes: Number(e.target.value),
                          label: `${e.target.value} min`,
                        };
                        setService({ ...s, options });
                      }}
                    />
                    min · $
                    <input
                      type="number"
                      min={1}
                      value={o.rate}
                      onChange={(e) => {
                        const options = [...s.options];
                        options[oi] = { ...o, rate: Number(e.target.value) };
                        setService({ ...s, options });
                      }}
                    />
                    /{s.rateUnit}
                    <button
                      onClick={() =>
                        setService({
                          ...s,
                          options: s.options.filter((_, k) => k !== oi),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    setService({
                      ...s,
                      options: [...s.options, { label: '30 min', durationMinutes: 30, rate: 20 }],
                    })
                  }
                >
                  Add duration
                </button>
              </div>
            )}

            <div className="pb-questions">
              <h3>Questions</h3>
              {s.questions.map((q, qi) => (
                <QuestionRow
                  key={q.id}
                  question={q}
                  onChange={(next) => {
                    const questions = [...s.questions];
                    questions[qi] = next;
                    setService({ ...s, questions });
                  }}
                  onRemove={() =>
                    setService({ ...s, questions: s.questions.filter((_, k) => k !== qi) })
                  }
                  onMoveUp={
                    qi > 0
                      ? () => {
                          const questions = [...s.questions];
                          [questions[qi - 1], questions[qi]] = [questions[qi], questions[qi - 1]];
                          setService({ ...s, questions });
                        }
                      : undefined
                  }
                  onMoveDown={
                    qi < s.questions.length - 1
                      ? () => {
                          const questions = [...s.questions];
                          [questions[qi], questions[qi + 1]] = [questions[qi + 1], questions[qi]];
                          setService({ ...s, questions });
                        }
                      : undefined
                  }
                />
              ))}
              <button
                type="button"
                onClick={() => setService({ ...s, questions: [...s.questions, emptyQuestion()] })}
              >
                Add question
              </button>
            </div>

            <div className="pb-limits">
              <h3>Booking limits</h3>
              {s.shape === 'range' && (
                <>
                  <NullableNumberField
                    label="Min nights"
                    value={s.minNights}
                    onChange={(minNights) => setService({ ...s, minNights })}
                  />
                  <NullableNumberField
                    label="Max nights"
                    value={s.maxNights}
                    onChange={(maxNights) => setService({ ...s, maxNights })}
                  />
                </>
              )}
              <NullableNumberField
                label="Min pets"
                value={s.minPetCount}
                onChange={(minPetCount) => setService({ ...s, minPetCount })}
              />
              <NullableNumberField
                label="Max pets"
                value={s.maxPetCount}
                onChange={(maxPetCount) => setService({ ...s, maxPetCount })}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
