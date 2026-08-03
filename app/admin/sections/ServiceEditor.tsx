import { blockNegativeNumberKeys, clampNullableNumber, NullableNumberField } from './fields.js';
import type { QuestionForm, ServiceForm, ServiceOptionForm } from '../shared.js';
import { Hint } from '../Hint';
import {
  buildMixKey,
  isValidRate,
  parseMixKey,
  US_HOLIDAY_NAMES,
  type PetMix,
} from '../../../src/shared/index.js';

/** One row of the cancellation-policy editor, mirroring the wire/shared CancellationTier shape. */
type ServiceEditorTier = { withinDays: number; percent: number };

/** Mirrors MAX_SERVICE_DESCRIPTION in server/routes/admin.ts — UX only; the server still validates. */
const MAX_DESCRIPTION = 200;

/** Mirrors MAX_OPTIONS_PER_SERVICE in server/lib/services.ts — UX only (it hides the Add button);
 * `resolveServiceOptions` is the authority and 400s an oversized payload independently. */
const MAX_OPTIONS = 8;

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
    petRates: [],
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
          className="pb-question-input"
          placeholder="Question"
          aria-label="Question text"
          value={question.label}
          onChange={(e) => onChange({ ...question, label: e.target.value })}
        />
        <select
          value={question.type}
          aria-label="Answer type"
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
          <button
            type="button"
            aria-label={`Move "${question.label || 'question'}" up`}
            onClick={onMoveUp}
          >
            <span aria-hidden="true">↑</span>
          </button>
        )}
        {onMoveDown && (
          <button
            type="button"
            aria-label={`Move "${question.label || 'question'}" down`}
            onClick={onMoveDown}
          >
            <span aria-hidden="true">↓</span>
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
            aria-label="Lowest allowed answer"
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
            aria-label="Highest allowed answer"
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
          aria-label="Choices, comma-separated"
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
 * Multi-pet pricing for one service: the MODE (what happens to a combination the sitter never
 * priced) plus the priced combinations themselves, per option.
 *
 * Two deliberate shapes, both borrowed from the cancellation-policy editor below — the house
 * standard for "a rule a sitter has to understand before they trust it":
 *
 * 1. The rule is stated once, in one plain sentence, with the mode as an inline control INSIDE
 *    that sentence rather than a checkbox floating above it. A sitter reading "When a client books
 *    more than one pet, charge …" learns what their unpriced combinations do without inferring it
 *    from the absence of a row.
 * 2. Each combination row is itself a sentence with its inputs embedded — "When a client books
 *    [2] [Dogs], charge $[60] per night" — instead of a bare rank of spinners a sitter has to
 *    decode ("2 in the Dogs box, 0 in the Cats box" meaning "any two dogs").
 *
 * Every stored combination BEATS the mode, in both modes, which is why the row list reads as
 * "override" copy under `linear`. The canonical mixKey is still built client-side with the shared
 * `buildMixKey` the server validates against — key construction only, never a price computation.
 * The client never multiplies anything: the mode is a stored value it renders and edits, and the
 * resulting money comes back from the server's quote. All edits flow through `setService` into the
 * staged draft; the save bar commits. An unfilled row ('' rate or empty mix) blocks saving.
 */
function PetRatesEditor({
  service: s,
  setService,
  petTypes,
}: {
  service: ServiceForm;
  setService: (next: ServiceForm) => void;
  petTypes: { petType: string; label: string }[];
}) {
  const accepted = petTypes.filter(
    (pt) => s.acceptedPetTypes === null || s.acceptedPetTypes.includes(pt.petType),
  );
  const linear = s.petRateMode === 'linear';
  const setOptionRates = (oi: number, petRates: ServiceOptionForm['petRates']) => {
    const options = [...s.options];
    options[oi] = { ...options[oi], petRates };
    setService({ ...s, options });
  };
  // Null-prototype copy: species slugs are sitter-controlled and 'constructor' is reachable —
  // a {...mix} spread would hand back a plain object whose reads fall through to
  // Object.prototype. parseMixKey already returns null-proto; keep it that way when updating.
  const withCount = (mix: PetMix, slug: string, count: number): PetMix => {
    const next: PetMix = Object.assign(Object.create(null) as PetMix, mix);
    next[slug] = count;
    return next;
  };
  /** The species clauses of one row, in key order, so the sentence reads the same every render. */
  const clausesOf = (mix: PetMix): { slug: string; count: number }[] =>
    Object.keys(mix)
      .filter((slug) => Number.isInteger(mix[slug]) && mix[slug] > 0)
      .sort()
      .map((slug) => ({ slug, count: mix[slug] }));
  const labelOf = (slug: string) => petTypes.find((pt) => pt.petType === slug)?.label ?? slug;
  /** Next row's starting combination: one more of the previous row's first species (the
   *  cancellation editor's derive-from-the-last-row idiom), else two of the first accepted type. */
  const nextRowMixKey = (rows: ServiceOptionForm['petRates']): string => {
    const first = accepted[0]?.petType;
    if (!first) return '';
    const last = rows[rows.length - 1];
    const lastClauses = last ? clausesOf(parseMixKey(last.mixKey)) : [];
    const seed = lastClauses[0];
    return seed
      ? buildMixKey(withCount(parseMixKey(last!.mixKey), seed.slug, seed.count + 1))
      : buildMixKey({ [first]: 2 });
  };
  return (
    <div className="pb-limits">
      <h3>
        Multi-pet pricing
        <Hint label="Multi-pet pricing">
          What a booking with more than one pet costs. Either every pet multiplies your rate, or
          only the combinations you price below can be booked together — your choice, stated in the
          sentence under this heading. A combination you price always wins over the multiplier, so
          you can charge less for the second dog just by adding a row. A service you add starts on
          the multiply setting; deleting a service and adding it back starts it fresh there too, so
          check this line after you re-create one.
        </Hint>
      </h3>
      <p className="pb-inline pb-mix-mode">
        When a client books more than one pet, charge{' '}
        <select
          aria-label="How bookings with more than one pet are priced"
          value={s.petRateMode}
          onChange={(e) =>
            setService({ ...s, petRateMode: e.target.value === 'linear' ? 'linear' : 'exact' })
          }
        >
          <option value="linear">my rate × the number of pets</option>
          <option value="exact">only the combinations I price below</option>
        </select>
        .
      </p>
      <p className="pb-hint">
        {linear ? (
          <>
            So two dogs cost twice your one-dog rate — on holidays too. Add a combination below to
            charge something else for it.
          </>
        ) : (
          <>
            So a combination you haven&rsquo;t priced below can&rsquo;t be booked at all. Rates for
            specific pets beat these species rates, which beat your base rate.
          </>
        )}
      </p>
      {s.options.map((o, oi) => (
        <div className="pb-mix-option" key={o.optionKey ?? `new-${oi}`}>
          {s.options.length > 1 && <strong className="pb-mix-option-label">{o.label}</strong>}
          {o.petRates.map((r, ri) => {
            const mix = parseMixKey(r.mixKey);
            const clauses = clausesOf(mix);
            const setRow = (next: { mixKey: string; rate: number | '' }) =>
              setOptionRates(
                oi,
                o.petRates.map((row, k) => (k === ri ? next : row)),
              );
            const unusedSpecies = accepted.filter(
              (pt) => !clauses.some((cl) => cl.slug === pt.petType),
            );
            return (
              <div className="pb-inline pb-mix-row" key={ri}>
                When a client books
                {clauses.map((cl, ci) => (
                  <span className="pb-inline" key={cl.slug}>
                    {ci > 0 && 'and'}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      aria-label={`Combination ${ri + 1} of ${o.label}: how many ${labelOf(cl.slug)}`}
                      value={cl.count}
                      onChange={(e) =>
                        setRow({
                          ...r,
                          mixKey: buildMixKey(withCount(mix, cl.slug, Number(e.target.value))),
                        })
                      }
                    />
                    <select
                      aria-label={`Combination ${ri + 1} of ${o.label}: which pet type`}
                      value={cl.slug}
                      onChange={(e) => {
                        // Move the count to the newly chosen species; the old slug drops out of
                        // the key when its count goes to 0 (buildMixKey filters non-positives).
                        const moved = withCount(
                          withCount(mix, cl.slug, 0),
                          e.target.value,
                          cl.count,
                        );
                        setRow({ ...r, mixKey: buildMixKey(moved) });
                      }}
                    >
                      {/* The row's own species is always listed — even if the service has since
                          stopped accepting it — so the shown value can never disagree with the
                          stored key. Species already used by ANOTHER clause of this row are
                          hidden, since one row cannot name a species twice. */}
                      {(accepted.some((pt) => pt.petType === cl.slug)
                        ? accepted
                        : [{ petType: cl.slug, label: labelOf(cl.slug) }, ...accepted]
                      )
                        .filter(
                          (pt) =>
                            pt.petType === cl.slug || !clauses.some((c2) => c2.slug === pt.petType),
                        )
                        .map((pt) => (
                          <option key={pt.petType} value={pt.petType}>
                            {pt.label}
                          </option>
                        ))}
                    </select>
                    {clauses.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Combination ${ri + 1} of ${o.label}: drop ${labelOf(cl.slug)}`}
                        onClick={() =>
                          setRow({ ...r, mixKey: buildMixKey(withCount(mix, cl.slug, 0)) })
                        }
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </span>
                ))}
                {unusedSpecies.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setRow({
                        ...r,
                        mixKey: buildMixKey(withCount(mix, unusedSpecies[0].petType, 1)),
                      })
                    }
                  >
                    {/* A row emptied to zero pets has no sentence left to extend — the button
                        becomes how the sitter puts one back, rather than an "and" with no "this". */}
                    {clauses.length === 0 ? 'pick a pet type' : 'and another pet type'}
                  </button>
                )}
                , charge $
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  required
                  aria-invalid={!isValidRate(r.rate)}
                  aria-label={`Price for combination ${ri + 1} of ${o.label}`}
                  value={r.rate}
                  onChange={(e) =>
                    setRow({ ...r, rate: e.target.value === '' ? '' : Number(e.target.value) })
                  }
                />
                per {s.rateUnit}
                <button
                  type="button"
                  onClick={() =>
                    setOptionRates(
                      oi,
                      o.petRates.filter((_, k) => k !== ri),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() =>
              setOptionRates(oi, [...o.petRates, { mixKey: nextRowMixKey(o.petRates), rate: '' }])
            }
          >
            Add another combination
          </button>
        </div>
      ))}
      {s.options.some((o) => o.petRates.some((r) => r.mixKey === '')) && (
        <p className="pb-error" role="alert">
          Each combination needs at least one pet.
        </p>
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
  dirty,
  saveBlocked,
  onSave,
  onFlashSavebar,
}: {
  service: ServiceForm;
  setService: (next: ServiceForm) => void;
  id?: string;
  labelledBy?: string;
  onDone?: () => void;
  onDelete?: () => void;
  petTypes: { petType: string; label: string }[]; // the tenant's pet-type registry
  /** True while any staged change is unsaved — enables the inline save + Save-button flash. */
  dirty?: boolean;
  /** True while an unpriced option blocks saving. */
  saveBlocked?: boolean;
  /** Page-level staged-settings save (the save bar's action), surfaced inline. */
  onSave?: () => void;
  /** Pulses the fixed save bar so the sitter can find where changes are committed. */
  onFlashSavebar?: () => void;
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
          <label className="pb-optname">
            <span className="pb-labelrow">
              Option name{' '}
              <span className="pb-hint">
                (what clients see — e.g. &ldquo;Standard {s.label.toLowerCase()}&rdquo;)
              </span>
            </span>
            <input
              placeholder="Standard"
              value={s.options[0]?.label ?? 'Standard'}
              onChange={(e) =>
                setService({
                  ...s,
                  options: [{ ...(s.options[0] ?? emptyOption()), label: e.target.value }],
                })
              }
            />
          </label>
          $
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            required
            aria-invalid={!isValidRate(s.options[0]?.rate)}
            aria-label={`Price in dollars per ${s.rateUnit}`}
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
                  <label className="pb-optname">
                    <span className="pb-labelrow">
                      Option name{' '}
                      <span className="pb-hint">
                        (what clients see — e.g. &ldquo;30 min&rdquo;, &ldquo;Morning walk&rdquo;)
                      </span>
                    </span>
                    <input
                      placeholder="Standard"
                      value={o.label}
                      onChange={(e) => setOption({ label: e.target.value })}
                    />
                  </label>
                  {!windowed && (
                    <input
                      type="number"
                      min={1}
                      placeholder="min"
                      aria-label="Length in minutes"
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
                    aria-label={`Price in dollars per ${s.rateUnit} for ${o.label || 'this option'}`}
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
                    aria-label="Pickup window start"
                    value={o.startTime ?? ''}
                    onChange={(e) => setOption({ startTime: e.target.value || null })}
                  />
                  <input
                    type="time"
                    aria-label="Pickup window end"
                    value={o.endTime ?? ''}
                    onChange={(e) => setOption({ endTime: e.target.value || null })}
                  />
                  <NullableNumberField
                    label="Capacity"
                    value={o.capacity}
                    onChange={(capacity) => setOption({ capacity })}
                    hint={
                      <Hint label="Capacity">
                        How many pets this time slot can take. A booking with three dogs uses three
                        spots. A full slot stops being offered; blank means no limit.
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
          {s.options.length < MAX_OPTIONS ? (
            <button
              type="button"
              onClick={() =>
                setService({
                  ...s,
                  options: [
                    ...s.options,
                    { ...emptyOption(), label: '30 min', durationMinutes: 30 },
                  ],
                })
              }
            >
              Add an option
            </button>
          ) : (
            // A button that simply vanishes reads as a bug. Say why it is gone — and say it in a
            // way that is also true for a service that predates the cap and holds MORE than it,
            // which stays fully editable (the server grandfathers it; see resolveServiceOptions).
            <p className="pb-hint">
              {s.options.length > MAX_OPTIONS
                ? `This service has ${s.options.length} options, more than the limit of ${MAX_OPTIONS}. They all keep working and stay editable — remove one before adding another.`
                : `That's the limit of ${MAX_OPTIONS} options on one service. Remove one to add another.`}
            </p>
          )}
        </div>
      )}
      <div className="pb-inline">
        <label className="pb-inline">
          <span className="pb-labelrow">
            Holiday rate (optional)
            <Hint label="Holiday rate">
              An explicit price per {s.rateUnit} for{' '}
              {s.rateUnit === 'night' ? 'nights that start' : 'days that fall'} on one of these
              days: {US_HOLIDAY_NAMES.join(', ')}. Leave it blank to charge your normal rate all
              year. It is a rate you set, not a percentage — set it lower than your normal rate if
              you like. If multi-pet pricing below is set to multiply, holiday {s.rateUnit}s
              multiply the same way; a combination you price yourself always wins.
            </Hint>
          </span>
          $
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="Usual rate"
            aria-label={`Holiday rate in dollars per ${s.rateUnit}, optional`}
            aria-invalid={
              s.holidayRate !== '' && s.holidayRate != null && !isValidRate(s.holidayRate)
            }
            value={s.holidayRate ?? ''}
            onChange={(e) =>
              setService({
                ...s,
                holidayRate: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
          /{s.rateUnit}
        </label>
      </div>
      {/* Extra-time surcharge. Rendered only where the OWNER sets the booking's times — a
          duration-priced service (walk, check-in) takes its clock from the option the client picked,
          so a "standard hour" there could never fire and the server rejects it outright rather than
          storing config that silently never applies. */}
      {!s.hasDuration && (
        <div className="pb-extratime">
          <span className="pb-labelrow">
            Standard hours &amp; extra-time fees (optional)
            <Hint label="Extra-time fees">
              The hours a {s.label.toLowerCase()} normally starts and ends, plus what you charge
              when a client asks to arrive earlier or leave later. Each side needs BOTH a time and a
              fee to do anything — leave either blank and nothing is charged. The fee is a FLAT
              amount charged once per booking, not per hour and not per day, and it is added as a
              separate line on the booking rather than folded into the stay price. Clients see it in
              their quote before they book, so nobody is surprised by it.
            </Hint>
          </span>
          <div className="pb-inline">
            <label className="pb-inline">
              Normally starts
              <input
                type="time"
                aria-label="The time a booking normally starts, optional"
                value={s.standardArrivalTime ?? ''}
                onChange={(e) => setService({ ...s, standardArrivalTime: e.target.value || null })}
              />
            </label>
            <label className="pb-inline">
              Earlier costs $
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="No fee"
                aria-label="Early arrival fee in dollars, optional"
                aria-invalid={
                  s.earlyArrivalFee !== '' &&
                  s.earlyArrivalFee != null &&
                  !isValidRate(s.earlyArrivalFee)
                }
                value={s.earlyArrivalFee ?? ''}
                onChange={(e) =>
                  setService({
                    ...s,
                    earlyArrivalFee: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <div className="pb-inline">
            <label className="pb-inline">
              Normally ends
              <input
                type="time"
                aria-label="The time a booking normally ends, optional"
                value={s.standardDepartureTime ?? ''}
                onChange={(e) =>
                  setService({ ...s, standardDepartureTime: e.target.value || null })
                }
              />
            </label>
            <label className="pb-inline">
              Later costs $
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="No fee"
                aria-label="Late departure fee in dollars, optional"
                aria-invalid={
                  s.lateDepartureFee !== '' &&
                  s.lateDepartureFee != null &&
                  !isValidRate(s.lateDepartureFee)
                }
                value={s.lateDepartureFee ?? ''}
                onChange={(e) =>
                  setService({
                    ...s,
                    lateDepartureFee: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
        </div>
      )}
      {/* Covers both pricing shapes above. A price left blank blocks the save bar (App.tsx), so say
          so where the empty input is rather than only in the bar at the bottom of the page. */}
      {s.options.some((o) => o.rate === '') && (
        <p className="pb-error" role="alert">
          Every option needs a price before you can save.
        </p>
      )}
      <PetRatesEditor service={s} setService={setService} petTypes={petTypes} />

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
          <NullableNumberField
            label="Max nights"
            value={s.maxNights}
            onChange={(maxNights) => setService({ ...s, maxNights })}
            hint={
              <Hint label="Max nights">
                The longest single stay a client can request for this service. Blank means no limit.
                It caps one booking&rsquo;s length, not how many stays they book.
              </Hint>
            }
          />
        )}
        <NullableNumberField
          label="Max pets"
          value={s.maxPetCount}
          onChange={(maxPetCount) => setService({ ...s, maxPetCount })}
          hint={
            <Hint label="Max pets">
              The most pets a client can put on ONE booking of this service. Blank means no limit.
              Different from &ldquo;pets in care&rdquo; above, which counts every pet across all
              overlapping bookings.
            </Hint>
          }
        />
        <label>
          <span className="pb-labelrow">
            Days of notice needed <span className="pb-hint">(blank = same-day OK)</span>
            <Hint label="Days of notice needed">
              How much warning you need before this service starts. Set it to 1 and clients
              can&rsquo;t request today — tomorrow is the earliest they can pick. Blank means
              same-day requests are fine. There&rsquo;s also one business-wide limit on how far
              AHEAD clients can book, under Business.
            </Hint>
          </span>
          <input
            type="number"
            min={0}
            max={90}
            aria-label="Days of notice needed (blank = same-day OK)"
            aria-invalid={
              s.minLeadDays !== null &&
              (!Number.isInteger(s.minLeadDays) || s.minLeadDays < 0 || s.minLeadDays > 90)
            }
            value={s.minLeadDays ?? ''}
            // Clamped to this input's OWN min/max as the sitter types, same as maxAdvanceMonths in
            // BusinessSection — `min` alone is advisory and a negative/decimal value would
            // otherwise reach the settings PUT and 400 (fields.js).
            onKeyDown={blockNegativeNumberKeys(0)}
            onChange={(e) =>
              setService({
                ...s,
                minLeadDays: clampNullableNumber(e.target.value, {
                  min: 0,
                  max: 90,
                  current: s.minLeadDays,
                }),
              })
            }
          />
        </label>
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
              aria-label={`Tier ${i + 1}: days before the start date`}
              value={t.withinDays}
              // Same clamp-as-you-type guard as the nullable fields (fields.js) — withinDays has
              // no blank state, so a cleared/negative keystroke falls back to the floor (0) rather
              // than reaching state as NaN or a negative number and 400ing the settings PUT.
              onKeyDown={blockNegativeNumberKeys(0)}
              onChange={(e) =>
                updateTier(i, {
                  ...t,
                  withinDays:
                    clampNullableNumber(e.target.value, { min: 0, current: t.withinDays }) ?? 0,
                })
              }
            />{' '}
            days of start:{' '}
            <input
              type="number"
              min={1}
              max={100}
              aria-label={`Tier ${i + 1}: fee as percent of cost`}
              value={t.percent}
              onKeyDown={blockNegativeNumberKeys(1)}
              onChange={(e) =>
                updateTier(i, {
                  ...t,
                  percent:
                    clampNullableNumber(e.target.value, {
                      min: 1,
                      max: 100,
                      current: t.percent,
                    }) ?? 1,
                })
              }
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

      {(onDelete !== undefined || onDone !== undefined || onSave !== undefined) && (
        <div className="pb-svc-editor-foot">
          {onDelete && (
            <button type="button" className="pb-danger" onClick={onDelete}>
              Delete service
            </button>
          )}
          {onSave && (
            <button
              type="button"
              className="pb-save-inline"
              disabled={!dirty || saveBlocked}
              onClick={onSave}
            >
              Save changes
            </button>
          )}
          {onDone && (
            <button
              type="button"
              onClick={() => {
                // Collapse is still staging-only; if edits are pending, pulse the save bar so
                // the hand-off to where the commit happens stays visible.
                if (dirty) onFlashSavebar?.();
                onDone();
              }}
            >
              Close
            </button>
          )}
        </div>
      )}
    </div>
  );
}
