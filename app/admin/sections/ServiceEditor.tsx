import { NullableNumberField } from './fields.js';
import type { QuestionForm, ServiceForm, ServiceOptionForm } from '../shared.js';
import { Hint } from '../Hint';

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
    weekdaysOnly: false,
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

/**
 * The full per-service editor — Pricing & options, Questions, Booking limits — extracted
 * verbatim from the old inline ServicesSection JSX (spec: 2026-07-19-services-rates-redesign;
 * re-presentation only, no field removed or renamed). All edits flow through `setService`
 * into the staged settings draft; the sticky save bar remains the single save surface.
 */
export function ServiceEditor({
  service: s,
  setService,
  id,
  labelledBy,
  onDone,
  onDelete,
  petTypes,
}: {
  service: ServiceForm;
  setService: (next: ServiceForm) => void;
  id?: string;
  labelledBy?: string;
  onDone?: () => void;
  onDelete?: () => void;
  petTypes: { petType: string; label: string }[]; // the tenant's pet-type registry
}) {
  return (
    <div
      className="pb-svc-editor"
      role="region"
      id={id}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : s.label}
    >
      <h3>Pricing &amp; options</h3>
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
                options: [{ ...(s.options[0] ?? emptyOption()), rate: Number(e.target.value) }],
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
                          ...(o.label === autoLabel ? { label: `${durationMinutes} min` } : {}),
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
                  <Hint label="Capacity">
                    How many bookings this time slot can take. A booking with three dogs still uses
                    one spot. A full slot stops being offered; blank means no limit.
                  </Hint>
                  {windowed && (
                    <>
                      <label className="pb-inline">
                        <input
                          type="checkbox"
                          checked={o.weekdaysOnly}
                          onChange={(e) => setOption({ weekdaysOnly: e.target.checked })}
                        />
                        Weekdays only
                      </label>
                      <Hint label="Weekdays only">
                        Clients will only see this option on Mondays through Fridays. It appears
                        once the option has a time window.
                      </Hint>
                    </>
                  )}
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
            onRemove={() => setService({ ...s, questions: s.questions.filter((_, k) => k !== qi) })}
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
        {s.capacityKind === 'boarding' && (
          <div className="pb-cap-row">
            <NullableNumberField
              label="Boarding spots per day (pets)"
              value={s.maxConcurrentPets}
              onChange={(maxConcurrentPets) => setService({ ...s, maxConcurrentPets })}
            />
            <Hint label="Boarding spots per day">
              Blank means no limit. Set a number and Pawbook stops offering new bookings once that
              day is full.
            </Hint>
          </div>
        )}
        {s.capacityKind === 'housesit' && (
          <div className="pb-cap-row">
            <NullableNumberField
              label="House-sits per day"
              value={s.maxPerDay}
              onChange={(maxPerDay) => setService({ ...s, maxPerDay })}
            />
            <Hint label="House-sits per day">
              Blank means no limit. Set a number and Pawbook stops offering new house-sit bookings
              once that many are already booked for the day.
            </Hint>
          </div>
        )}
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

      <div className="pb-limits">
        <h3>Accepted pets</h3>
        <p className="pb-hint">
          All checked = accepts every type, including ones you add later. Uncheck one and this
          service locks to exactly the checked list.
        </p>
        {petTypes.map((pt) => {
          const checked = s.acceptedPetTypes === null || s.acceptedPetTypes.includes(pt.petType);
          return (
            <label className="pb-inline" key={pt.petType}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  const enabledSlugs = petTypes.map((t) => t.petType);
                  const current = s.acceptedPetTypes ?? enabledSlugs;
                  const next = e.target.checked
                    ? [...current, pt.petType]
                    : current.filter((t) => t !== pt.petType);
                  // Re-checking every enabled type normalizes back to NULL, so the service
                  // keeps auto-accepting types the sitter adds later.
                  const all = enabledSlugs.every((t) => next.includes(t));
                  setService({ ...s, acceptedPetTypes: all ? null : next });
                }}
              />
              {pt.label}
            </label>
          );
        })}
      </div>

      {(onDelete !== undefined || onDone !== undefined) && (
        <div className="pb-svc-editor-foot">
          {onDelete && (
            <button type="button" className="pb-danger" onClick={onDelete}>
              Delete service
            </button>
          )}
          {onDone && (
            <button type="button" onClick={onDone}>
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}
