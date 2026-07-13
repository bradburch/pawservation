import { useState } from 'react';
import { NullableNumberField } from './fields.js';
import { IconPaw, IconTag, SERVICE_ICONS } from '../../shared-ui/icons';
import type {
  QuestionForm,
  ServiceForm,
  ServiceOptionForm,
  Settings,
  SettingsSectionProps,
} from '../shared.js';

function ServiceIcon({ icon }: { icon: string }) {
  const Icon = SERVICE_ICONS[icon] ?? IconPaw;
  return <Icon size={16} />;
}

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

function emptyOption(): ServiceOptionForm {
  return {
    label: 'Standard',
    durationMinutes: null,
    rate: 0,
    startTime: null,
    endTime: null,
    capacity: null,
  };
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

function AddServiceForm({
  templates,
  addService,
}: {
  templates: Settings['templates'];
  addService: (template: string, label: string) => Promise<void>;
}) {
  const [template, setTemplate] = useState(templates[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !label.trim() || !template) return;
    setBusy(true);
    try {
      await addService(template, label.trim());
      setLabel('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-inline">
      <select value={template} onChange={(e) => setTemplate(e.target.value)}>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="Service name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button type="button" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Adding…' : 'Add service'}
      </button>
    </div>
  );
}

export function ServicesSection({
  settings,
  setSettings,
  addService,
  removeService,
}: SettingsSectionProps & {
  addService: (template: string, label: string) => Promise<void>;
  removeService: (type: string) => Promise<void>;
}) {
  return (
    <>
      <h2>
        <IconTag size={18} /> Services &amp; rates
      </h2>
      <p className="pb-hint">
        Tick the services you offer. To create a new offering clients can book (say, a 30-minute
        &ldquo;Puppy Check-in&rdquo;), add it as an option under Walks or Check-ins with its own
        name, length, and price.
      </p>
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
              <ServiceIcon icon={s.icon} /> {s.label}
            </label>
            {s.custom && (
              <button type="button" onClick={() => void removeService(s.type)}>
                Delete
              </button>
            )}
            {!s.hasDuration ? (
              <div className="pb-inline">
                <input
                  placeholder="Label"
                  value={s.options[0]?.label ?? 'Standard'}
                  onChange={(e) =>
                    setService({
                      ...s,
                      options: [{ ...(s.options[0] ?? emptyOption()), label: e.target.value }],
                    })
                  }
                />
                $
                <input
                  type="number"
                  min={1}
                  value={s.options[0]?.rate ?? 0}
                  onChange={(e) =>
                    setService({
                      ...s,
                      options: [
                        { ...(s.options[0] ?? emptyOption()), rate: Number(e.target.value) },
                      ],
                    })
                  }
                />
                /{s.rateUnit}
              </div>
            ) : (
              <div className="pb-options">
                {s.options.map((o, oi) => {
                  const windowed = o.startTime !== null && o.endTime !== null;
                  const setOption = (patch: Partial<ServiceOptionForm>) => {
                    const options = [...s.options];
                    options[oi] = { ...o, ...patch };
                    setService({ ...s, options });
                  };
                  return (
                    <div key={oi}>
                      <div className="pb-inline">
                        <input
                          placeholder="Label"
                          value={o.label}
                          onChange={(e) => setOption({ label: e.target.value })}
                        />
                        {!windowed && (
                          <input
                            type="number"
                            min={1}
                            placeholder="min"
                            value={o.durationMinutes ?? 0}
                            onChange={(e) => {
                              const durationMinutes = Number(e.target.value);
                              // Keep the label in sync with duration until the sitter customizes
                              // it — detected by the current label still matching what
                              // auto-derivation would have produced for the current duration.
                              const autoLabel = `${o.durationMinutes ?? 0} min`;
                              setOption({
                                durationMinutes,
                                ...(o.label === autoLabel
                                  ? { label: `${durationMinutes} min` }
                                  : {}),
                              });
                            }}
                          />
                        )}
                        {!windowed ? 'min · $' : '$'}
                        <input
                          type="number"
                          min={1}
                          value={o.rate}
                          onChange={(e) => setOption({ rate: Number(e.target.value) })}
                        />
                        /{s.rateUnit}
                        <button
                          type="button"
                          onClick={() =>
                            setService({ ...s, options: s.options.filter((_, k) => k !== oi) })
                          }
                        >
                          Remove
                        </button>
                      </div>
                      <div className="pb-inline">
                        Window (optional)
                        <input
                          type="time"
                          value={o.startTime ?? ''}
                          onChange={(e) => setOption({ startTime: e.target.value || null })}
                        />
                        <input
                          type="time"
                          value={o.endTime ?? ''}
                          onChange={(e) => setOption({ endTime: e.target.value || null })}
                        />
                        <NullableNumberField
                          label="Capacity"
                          value={o.capacity}
                          onChange={(capacity) => setOption({ capacity })}
                        />
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() =>
                    setService({
                      ...s,
                      options: [
                        ...s.options,
                        { ...emptyOption(), label: '30 min', durationMinutes: 30, rate: 20 },
                      ],
                    })
                  }
                >
                  Add an option
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
      <div className="pb-service">
        <h3>Add service</h3>
        <AddServiceForm templates={settings.templates} addService={addService} />
      </div>
    </>
  );
}
