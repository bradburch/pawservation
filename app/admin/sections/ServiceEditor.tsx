import { NullableNumberField } from './fields.js';
import type { QuestionForm, ServiceForm, ServiceOptionForm } from '../shared.js';
import { Hint } from '../Hint';
import { isValidRate } from '../../../src/shared/index.js';

/** One row of the cancellation-policy editor, mirroring the wire/shared CancellationTier shape. */
type ServiceEditorTier = { withinDays: number; percent: number };

/** Mirrors MAX_SERVICE_DESCRIPTION in server/routes/admin.ts — UX only; the server still validates. */
const MAX_DESCRIPTION = 200;

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
    rate: '', // no default price — the sitter must type one before the save can succeed
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
  // Cancellation tiers edit through setService like every other field; an emptied list
  // normalizes back to null so "no policy" round-trips as the server's NULL sentinel.
  const tiers = s.cancellationTiers ?? [];
  const commitTiers = (next: ServiceEditorTier[]) =>
    setService({ ...s, cancellationTiers: next.length ? next : null });
  const updateTier = (i: number, next: ServiceEditorTier) =>
    commitTiers(tiers.map((t, k) => (k === i ? next : t)));
  const removeTier = (i: number) => commitTiers(tiers.filter((_, k) => k !== i));
  const addTier = () => {
    const last = tiers[tiers.length - 1];
    commitTiers([...tiers, { withinDays: (last?.withinDays ?? 0) + 5, percent: 50 }]);
  };
  // Boarding is priced/booked per night, daycare-style pools per day — the capacity label
  // must use the same noun the price does (RateUnit is the single source of that noun).
  const capUnit = s.rateUnit === 'night' ? 'night' : 'day';
  return (
    <div
      className="pb-svc-editor"
      role="region"
      id={id}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : s.label}
    >
      <label>
        Short description{' '}
        <span className="pb-hint">(optional — clients see this on your booking widget)</span>
        <input
          maxLength={MAX_DESCRIPTION}
          placeholder="e.g. Overnight stays at our home, two walks a day"
          value={s.description ?? ''}
          onChange={(e) => setService({ ...s, description: e.target.value || null })}
        />
      </label>

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
            step={1}
            inputMode="numeric"
            required
            aria-invalid={!isValidRate(s.options[0]?.rate)}
            value={s.options[0]?.rate ?? ''}
            onChange={(e) =>
              setService({
                ...s,
                options: [
                  {
                    ...(s.options[0] ?? emptyOption()),
                    rate: e.target.value === '' ? '' : Number(e.target.value),
                  },
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
                          ...(o.label === autoLabel ? { label: `${durationMinutes} min` } : {}),
                        });
                      }}
                    />
                  )}
                  {!windowed ? 'min · $' : '$'}
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    required
                    aria-invalid={!isValidRate(o.rate)}
                    value={o.rate}
                    onChange={(e) =>
                      setOption({ rate: e.target.value === '' ? '' : Number(e.target.value) })
                    }
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
                  Pickup window (optional)
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
                    hint={
                      <Hint label="Capacity">
                        How many pets this time slot can take. A booking with three dogs uses
                        three spots. A full slot stops being offered; blank means no limit.
                      </Hint>
                    }
                  />
                  {windowed && (
                    <span className="pb-labelrow">
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
                    </span>
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
                options: [...s.options, { ...emptyOption(), label: '30 min', durationMinutes: 30 }],
              })
            }
          >
            Add an option
          </button>
        </div>
      )}
      {/* Covers both pricing shapes above. A price left blank blocks the save bar (App.tsx), so say
          so where the empty input is rather than only in the bar at the bottom of the page. */}
      {s.options.some((o) => o.rate === '') && (
        <p className="pb-error">Every option needs a price before you can save.</p>
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
        {(s.capacityKind === 'boarding' || s.capacityKind === 'housesit') && (
          <NullableNumberField
            label={`Pets in care per ${capUnit}`}
            value={s.maxConcurrentPets}
            onChange={(maxConcurrentPets) => setService({ ...s, maxConcurrentPets })}
            hint={
              <Hint label={`Pets in care per ${capUnit}`}>
                Blank means no limit. Counts every pet in your care that {capUnit}, across all
                overlapping stays — a booking with three dogs uses three spots.
              </Hint>
            }
          />
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
          label="Max pets"
          value={s.maxPetCount}
          onChange={(maxPetCount) => setService({ ...s, maxPetCount })}
        />
      </div>

      <div className="pb-limits pb-tiers">
        <h3>
          Cancellation policy
          <Hint label="Cancellation policy">
            Blank = no cancellation fee. Tightest window wins.
          </Hint>
        </h3>
        {tiers.map((t, i) => (
          <div key={i} className="pb-inline">
            Within{' '}
            <input
              type="number"
              min={0}
              value={t.withinDays}
              onChange={(e) => updateTier(i, { ...t, withinDays: Number(e.target.value) })}
            />{' '}
            days of start:{' '}
            <input
              type="number"
              min={1}
              max={100}
              value={t.percent}
              onChange={(e) => updateTier(i, { ...t, percent: Number(e.target.value) })}
            />
            % of cost
            <button type="button" onClick={() => removeTier(i)}>
              Remove
            </button>
          </div>
        ))}
        {tiers.length < 5 && (
          <button type="button" onClick={addTier}>
            Add tier
          </button>
        )}
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
