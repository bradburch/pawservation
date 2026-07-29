import {
  nightsBetween,
  validateAnswers,
  validatePetTypeAcceptance,
  validateServiceConstraints,
} from '../../src/shared/index.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar } from './Calendar';
import {
  ApiError,
  api,
  getToken,
  isAuthExpired,
  type Availability,
  type Pet,
  type TenantConfig,
} from '../shared-ui/api';
import { IconCheck, IconChevronDown, IconPaw, SERVICE_ICONS } from '../shared-ui/icons';
import { QuestionField } from './QuestionField';
import { useAsync } from '../shared-ui/useAsync';
import { errorMsg, slug, parentOrigin } from './shared';

/**
 * A fresh key for ONE booking attempt. Held in a ref and reused across retries of that attempt so
 * a double-tap (or a lost response) replays into the original booking instead of creating a
 * second one; cleared whenever the request would describe something different.
 */
function newAttemptKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Older embedded webviews expose crypto but not randomUUID. Uniqueness only has to hold per
    // (tenant, customer) for the length of one attempt, which this comfortably does.
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** "Bella", "Bella and Mochi", "Bella, Mochi and 2 more" — the collapsed section's whole content. */
function petSummary(names: string[]): string {
  if (names.length === 0) return 'No pets selected';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function BookTab({
  config,
  pets,
  onAuthExpired,
}: {
  config: TenantConfig;
  pets: Pet[] | null;
  onAuthExpired: () => void;
}) {
  const [type, setType] = useState(config.services[0]?.type ?? 'boarding');
  const service = config.services.find((s) => s.type === type) ?? config.services[0];
  const [optionKey, setOptionKey] = useState(service?.options[0]?.optionKey ?? '');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [startTime, setStartTime] = useState('');
  // null = "still the default", which is EVERY accepted pet (see `defaultPetIds`). Held as a
  // sentinel rather than seeded into state so the default can be recomputed as the async pet list
  // arrives and as the service — and with it which pets are accepted — changes, without an effect
  // that would clobber a selection the customer had already made.
  const [petSelection, setPetSelection] = useState<string[] | null>(null);
  // null = "not decided by the customer", which falls through to `autoExpand`.
  const [petsOpen, setPetsOpen] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [calReloadKey, setCalReloadKey] = useState(0);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  // Set when the booking POST refuses on `unpriced_pet_set`; the quote reports the same state
  // ahead of time, and either one shows the contact card.
  const [postUnpriced, setPostUnpriced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const attemptKey = useRef<string | null>(null);

  const selectedOption = service?.options.find((o) => o.optionKey === optionKey);
  const petTypeLabels = new Map(config.petTypes.map((p) => [p.slug, p.label]));
  const labelOf = (petSlug: string) => petTypeLabels.get(petSlug) ?? petSlug;
  // Mirror of the server verdict: registry membership (slug present in config.petTypes — an
  // absent slug is corrupt/stale data) AND the service's own acceptance list (null = accepts all).
  const petAccepted = (p: Pet) =>
    petTypeLabels.has(p.petType) &&
    (!service?.acceptedPetTypes || service.acceptedPetTypes.includes(p.petType));

  // ── Pets: opt-out, not opt-in ──────────────────────────────────────────────
  // Everyone the service accepts is coming unless the customer says otherwise — the common case
  // by a wide margin. Clamped to the service's own MaxPetCount, because a default that cannot be
  // submitted is worse than no default: the household would land pre-selected in a state
  // `validateServiceConstraints` refuses, with the reason inside a collapsed section.
  const acceptedPets = (pets ?? []).filter(petAccepted);
  const maxPetCount = service?.maxPetCount ?? null;
  const defaultPets =
    maxPetCount === null ? acceptedPets : acceptedPets.slice(0, Math.max(0, maxPetCount));
  const clamped = defaultPets.length < acceptedPets.length;
  const selectedPets = petSelection ?? defaultPets.map((p) => p.id);
  const petKey = selectedPets.join(',');
  const selectedNames = (pets ?? []).filter((p) => selectedPets.includes(p.id)).map((p) => p.name);
  // Open the section by default only when the default itself needs looking at: fewer pets chosen
  // than the household has, no pets to choose, or none this service accepts. Errors never hide
  // behind it — they render outside the disclosure, below the button.
  const autoExpand = pets !== null && (clamped || pets.length === 0 || acceptedPets.length === 0);
  const petsExpanded = petsOpen ?? autoExpand;

  const acceptanceError = service
    ? validatePetTypeAcceptance(
        service.acceptedPetTypes,
        service.label,
        (pets ?? [])
          .filter((p) => selectedPets.includes(p.id))
          .map((p) => ({ name: p.name, petType: p.petType })),
        labelOf,
      )
    : null;
  const questionsError = service ? validateAnswers(service.questions, answers) : null;
  const nights = service?.shape === 'range' && start && end ? nightsBetween(start, end) : null;
  const constraintsError = service
    ? validateServiceConstraints(
        { maxNights: service.maxNights, maxPetCount: service.maxPetCount },
        { nights, petCount: selectedPets.length },
      )
    : null;

  /**
   * The pet-count half of `constraintsError`, isolated by asking the SAME shared validator with
   * the nights constraint switched off — never re-derived. Now that the roster sits above the
   * calendar, a bad pet selection is reachable before any date exists, i.e. before `.bp-details`
   * and its error slot are on the page at all; this is what explains it in place. (Zero selected
   * sends no `petIds`, so the server paints the grid for one pet — the neutral default — and
   * this line is what says so rather than leaving a phantom pet unexplained.)
   */
  const petCountError = service
    ? validateServiceConstraints(
        { maxNights: null, maxPetCount: service.maxPetCount },
        { nights: null, petCount: selectedPets.length },
      )
    : null;
  const petsNote =
    (selectedPets.length === 0 && pets !== null && pets.length > 0
      ? 'Choose at least one pet.'
      : '') ||
    acceptanceError ||
    petCountError ||
    '';

  const datesReady = !!start && (service?.shape !== 'range' || !!end);

  /**
   * Everything downstream of a changed selection: the confirmation, the last error, and the
   * idempotency key — because a key held across a change would replay a booking for the OLD
   * request. The quote clears itself (it is keyed on the same inputs).
   */
  const resetCheck = () => {
    setConfirmation('');
    setError('');
    setPostUnpriced(false);
    attemptKey.current = null;
  };

  const onServiceChange = (next: string) => {
    setType(next);
    const svc = config.services.find((s) => s.type === next);
    setOptionKey(svc?.options[0]?.optionKey ?? '');
    setStart('');
    setEnd('');
    setStartTime('');
    // Back to the default for the NEW service — acceptance and the pet cap are both per service.
    setPetSelection(null);
    setPetsOpen(null);
    setAnswers({});
    resetCheck();
  };

  // ── The silent quote ───────────────────────────────────────────────────────
  // There is no "Check availability" button any more: the price is fetched in the background on
  // every selection change and rendered beside the one primary button. `useAsync` is the
  // staleness guard — it drops any response that isn't the newest fetch's, and reports `loading`
  // for a result that no longer describes the current inputs, so a slow response can never
  // overwrite a newer selection (the same job the old `checkSeq` counter did, in the pattern the
  // rest of the widget already uses).
  const onAuthExpiredRef = useRef(onAuthExpired);
  useEffect(() => {
    onAuthExpiredRef.current = onAuthExpired;
  });

  // Skipped whenever the client can already see the request is invalid: the quote route mirrors
  // these same two checks and would just 400, and the customer is being shown that reason anyway.
  const quoteReady = datesReady && selectedPets.length > 0 && !acceptanceError && !constraintsError;
  const isRange = service?.shape === 'range';
  const fetchQuote = useCallback(async (): Promise<Availability | null> => {
    if (!quoteReady) return null;
    const token = getToken(slug);
    if (!token) return null;
    const params: Record<string, string> = {
      type,
      option: optionKey,
      start,
      // Real pet ids, not a count: the server prices the set the customer actually chose, and
      // there is no count for a client to inflate. Ids are UUIDs, so a comma join is safe.
      petIds: petKey,
    };
    if (isRange) params.end = end;
    try {
      return await api.availability(slug, token, params);
    } catch (e) {
      if (isAuthExpired(e)) {
        onAuthExpiredRef.current();
        // Never resolves — the parent unmounts this component as soon as auth state flips.
        return new Promise<Availability | null>(() => {});
      }
      throw e;
    }
  }, [quoteReady, type, optionKey, start, end, petKey, isRange]);

  const { data: quoteData, error: quoteError, loading: quoting } = useAsync(fetchQuote);
  // useAsync retains the last success across a dependency change, so a result is only THIS
  // selection's answer once the fetch it belongs to has settled.
  const quote = quoting ? null : quoteData;
  const quoteFailed = !quoting && !!quoteError;
  // Availability's own refusal (dates full, out of window, too many pets) — the authoritative
  // version of the calendar's optimistic hint.
  const quoteRefusal = quote && !quote.available ? quote.reason : null;
  const unpriced = postUnpriced || !!(quote && quote.available && !quote.priced);

  const blockingError = questionsError ?? constraintsError ?? acceptanceError;
  const canSubmit =
    !submitting &&
    datesReady &&
    selectedPets.length > 0 &&
    !blockingError &&
    !quoteRefusal &&
    !unpriced;

  const submit = async () => {
    if (submitting) return;
    setError('');
    setPostUnpriced(false);
    const token = getToken(slug);
    if (!token) {
      onAuthExpired();
      return;
    }
    // One key per attempt, generated on the first try and reused by every retry of it — the
    // server replays the original booking rather than creating a second.
    attemptKey.current ??= newAttemptKey();
    // What the customer was shown, so a stamp that disagrees can be said out loud rather than
    // silently replacing the number they read.
    const quoted = quote && quote.available && quote.priced ? quote.estCost : null;
    setSubmitting(true);
    try {
      const body = {
        type,
        optionKey,
        startDate: start,
        petIds: selectedPets,
        answers,
        ...(isRange ? { endDate: end, ...(startTime ? { startTime } : {}) } : {}),
      };
      const res = await api.createBooking(slug, token, body, attemptKey.current);
      const changed =
        quoted !== null && quoted !== res.estCost ? ` (the estimate showed $${quoted})` : '';
      setConfirmation(
        res.demo
          ? `Looks good! $${res.estCost}${changed}. ${res.note ?? 'This was a demo — no booking was created.'}`
          : `Request sent! $${res.estCost}${changed} — your sitter confirms it. Track it under "My bookings".`,
      );
      attemptKey.current = null;
      setStart('');
      setEnd('');
      setStartTime('');
      setPetSelection(null);
      setPetsOpen(null);
      setAnswers({});
      setCalReloadKey((k) => k + 1);
      // Both families, for HTTP-cached pre-rebrand loaders (see the resize note in App.tsx):
      // the current loader handles `pawservation:booked`, legacy loaders handle `pawbook:booked`.
      // Demo requests skip the notification — nothing was created for a host page to react to.
      if (!res.demo) {
        for (const type of ['pawservation:booked', 'pawbook:booked']) {
          window.parent.postMessage({ type, requestId: res.id }, parentOrigin);
        }
      }
    } catch (e) {
      if (isAuthExpired(e)) {
        onAuthExpired();
        return;
      }
      // The POST's stable code, not its prose: this is the one refusal with its own card.
      if (e instanceof ApiError && e.code === 'unpriced_pet_set') setPostUnpriced(true);
      else setError(errorMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!service) return <p>No services available yet.</p>;

  // The line beside the button: quantity and price, both straight from the server's answer.
  // NOT hedged — `estCost` is literally the number stamped on the booking — and the noun comes
  // from the quote's own `unit`, never from `service.rateUnit`, so a day-billed stay can never
  // show "4" next to "nights".
  const quoteLine = quoting
    ? 'Checking…'
    : quote && quote.available && quote.priced
      ? {
          units:
            quote.billedUnits != null && quote.unit != null
              ? `${quote.billedUnits} ${quote.unit}${quote.billedUnits === 1 ? '' : 's'}`
              : '',
          cost: `$${quote.estCost}`,
        }
      : '';

  const holidayNote =
    quote &&
    quote.available &&
    quote.priced &&
    quote.holidayUnits != null &&
    quote.holidayRate != null
      ? (() => {
          // Single-day services (walk/visit) never set `unit` — fall back to the service's own
          // rateUnit so the noun still comes from one source, never an invented default.
          const unit = quote.unit ?? service.rateUnit;
          return `Includes ${quote.holidayUnits} holiday ${unit}${quote.holidayUnits === 1 ? '' : 's'} at $${quote.holidayRate}${unit ? `/${unit}` : ''}.`;
        })()
      : '';

  const policyNote = service.cancellationTiers
    ? `Cancellation: ${service.cancellationTiers
        .map((t) => `${t.percent}% within ${t.withinDays} day${t.withinDays === 1 ? '' : 's'}`)
        .join(', ')}`
    : '';

  // One reserved line for everything that can go wrong, in the order it matters: what the POST
  // said, what the client can see for itself, what the quote said. It sits OUTSIDE the pets
  // disclosure on purpose — a collapsed section must never be able to hide an error.
  const noteLine =
    error ||
    // The button is disabled with nothing selected; without this it would be disabled with no
    // stated reason, which the old "Choose at least one pet." error used to supply on submit.
    (selectedPets.length === 0 && pets !== null && pets.length > 0
      ? 'Choose at least one pet.'
      : '') ||
    blockingError ||
    quoteRefusal ||
    (quoteFailed ? errorMsg(quoteError) : '') ||
    '';

  return (
    <div className="bp-book">
      <div className="bp-service-grid">
        {config.services.map((s) => {
          const Icon = SERVICE_ICONS[s.icon] ?? IconPaw;
          return (
            <button
              key={s.type}
              type="button"
              className={`bp-service-card${type === s.type ? ' bp-selected' : ''}`}
              aria-pressed={type === s.type}
              onClick={() => onServiceChange(s.type)}
            >
              <span className="bp-service-emoji" aria-hidden="true">
                <Icon />
              </span>
              <span className="bp-service-label">{s.label}</span>
              {/* Selection must not be color-only: the selected card also gets a check. It is a
                  SIBLING of the label, never a child, and it is ALWAYS rendered — hidden by CSS
                  when unselected, not removed. Inside the label it was one more inline word the
                  text wrapped around, so selecting a long-named service pushed the label onto an
                  extra line and grew the card; rendered conditionally, its box appeared and
                  disappeared. Either way the grid's height moved on a tap, and with it the height
                  this widget posts to its host iframe. See widget.css. */}
              <span className="bp-service-check" aria-hidden="true">
                <IconCheck size={13} />
              </span>
            </button>
          );
        })}
      </div>
      {/* Reserved height (see widget.css) so tapping between services doesn't resize the
          widget — and with it, the host page's iframe. */}
      <p className="bp-service-desc">{service.description}</p>

      {service?.hasDuration && (
        <label className="bp-field">
          Duration
          <select
            value={optionKey}
            onChange={(e) => {
              setOptionKey(e.target.value);
              // The calendar's availability grid is keyed by option (capacity varies per
              // option), so a date picked under the old option may not apply to the new one.
              setStart('');
              setEnd('');
              resetCheck();
            }}
          >
            {service.options.map((o) => (
              <option key={o.optionKey} value={o.optionKey}>
                {o.label}
                {o.startTime && o.endTime ? ` · ${o.startTime}–${o.endTime}` : ''} — ${o.rate}/
                {service.rateUnit}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* ABOVE the calendar, and deliberately outside `.bp-details`. The grid is painted for this
          set (task 8b), so this control is what a customer needs when the month comes back empty —
          and `.bp-details` only mounts once the dates are COMPLETE. Inside it, a two-pet household
          looking at a month where every day is 1/2 saw a fully struck-out grid, could pick no day,
          and so could never reach the one control that would untick a pet and repaint it. Reading
          order follows from the same fact: who's coming decides what the calendar can show. */}
      <div className="bp-pets-block">
        <button
          type="button"
          className="bp-disclosure"
          aria-expanded={petsExpanded}
          onClick={() => setPetsOpen(!petsExpanded)}
        >
          <span className="bp-disclosure-label">Who&apos;s coming?</span>
          <span className="bp-disclosure-summary">
            {pets === null ? 'Loading pets…' : petSummary(selectedNames)}
          </span>
          <span
            className={`bp-disclosure-chevron${petsExpanded ? ' bp-open' : ''}`}
            aria-hidden="true"
          >
            <IconChevronDown size={16} />
          </span>
        </button>
        {petsExpanded && (
          <fieldset className="bp-pets">
            <legend className="bp-sr-only">Pets on this booking</legend>
            {pets === null ? (
              <p className="bp-empty">Loading pets…</p>
            ) : pets.length === 0 ? (
              <p className="bp-empty">No pets added yet — ask your sitter to add yours.</p>
            ) : (
              <div className="bp-pet-chips">
                {pets.map((p) => {
                  const on = selectedPets.includes(p.id);
                  const ok = petAccepted(p);
                  return (
                    <label
                      className={`bp-pet-chip${on ? ' bp-on' : ''}${ok ? '' : ' bp-off'}`}
                      key={p.id}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!ok}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selectedPets, p.id]
                            : selectedPets.filter((id) => id !== p.id);
                          setPetSelection(next);
                          resetCheck();
                        }}
                      />
                      <span className="bp-chip-check" aria-hidden="true">
                        <IconCheck size={13} />
                      </span>
                      {p.name}
                      <span className="bp-pet-type">{labelOf(p.petType)}</span>
                      {!ok && <span className="bp-pet-hint">not accepted for {service.label}</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        )}
      </div>
      {/* The pet-count refusals belong beside the control that causes them, not only in the
          post-dates note slot the customer may not have reached yet. Reserved height, always
          rendered — see .bp-pets-note. */}
      <p className={`bp-pets-note${petsNote ? ' bp-note-bad' : ''}`}>{petsNote}</p>

      <Calendar
        slug={slug}
        token={getToken(slug) ?? ''}
        serviceType={type}
        optionKey={optionKey}
        // The grid is painted for the pets actually selected: a day with one of two slots left
        // is bookable for one pet and not for two, and this is what makes it refetch when the
        // customer changes who's coming.
        petIds={petKey}
        weekdaysOnly={selectedOption?.weekdaysOnly ?? false}
        shape={service.shape === 'range' ? 'range' : 'single'}
        month={month}
        onMonthChange={setMonth}
        value={{ start, end: end || undefined }}
        reloadKey={calReloadKey}
        onChange={(v) => {
          setStart(v.start ?? '');
          setEnd(v.end ?? '');
          resetCheck();
        }}
        onAuthExpired={onAuthExpired}
      />

      {datesReady && (
        <div className="bp-details">
          {service.shape === 'range' && (
            <label className="bp-field">
              Arrival time (optional)
              <input
                type="time"
                value={startTime}
                // resetCheck, like every other input: the arrival time is part of the request
                // BODY, so an attempt key held across an edit to it would replay the booking that
                // carried the old time (and leave a stale error on screen while they type).
                onChange={(e) => {
                  setStartTime(e.target.value);
                  resetCheck();
                }}
              />
            </label>
          )}
          {service && service.questions.length > 0 && (
            <fieldset className="bp-questions">
              <legend>
                {service.questions.length === 1 ? 'One quick question' : 'A few questions'}
              </legend>
              {service.questions.map((q) => (
                <QuestionField
                  key={q.id}
                  question={q}
                  value={answers[q.id] ?? ''}
                  // Same reason as the arrival time: answers ride in the request body, so an
                  // edited answer is a different attempt and must not inherit the old key.
                  onChange={(value) => {
                    setAnswers((cur) => ({ ...cur, [q.id]: value }));
                    resetCheck();
                  }}
                />
              ))}
            </fieldset>
          )}

          {/* One primary action. The quote rides beside it instead of gating it behind a second
              button — and every line here has reserved space (widget.css), so a quote landing or
              an error appearing never changes the widget's height. */}
          <div className="bp-actions">
            <button className="bp-primary" onClick={submit} disabled={!canSubmit}>
              {submitting ? 'Sending…' : 'Request Booking'}
            </button>
            <p className="bp-quote">
              {typeof quoteLine === 'string' ? (
                quoteLine
              ) : (
                <>
                  {quoteLine.units ? `${quoteLine.units} · ` : ''}
                  <strong>{quoteLine.cost}</strong>
                </>
              )}
            </p>
          </div>
          {/* Both lines share ONE gap from .bp-details: they are reserved space, and reserved
              space should cost the layout as little as it can while still never collapsing. */}
          <div className="bp-below-action">
            <p className="bp-fineprint">{[holidayNote, policyNote].filter(Boolean).join(' · ')}</p>
            <p className={`bp-note${noteLine ? ' bp-note-bad' : ''}`}>{noteLine}</p>
          </div>

          {unpriced && (
            // The dates are free but the sitter never priced this pet set. Submit is blocked
            // above; there is nothing here that computes a price to send in its place.
            <div className="bp-result bp-unpriced">
              <p>
                Those dates are free — but {config.displayName} hasn&rsquo;t set a price for this
                group of pets yet.
              </p>
              <p>
                {config.contactEmail || config.contactPhone ? (
                  <>
                    Ask about a rate for{' '}
                    {selectedPets.length === 1 ? 'this pet' : `these ${selectedPets.length} pets`}{' '}
                    at{' '}
                    {config.contactEmail ? (
                      <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>
                    ) : null}
                    {config.contactEmail && config.contactPhone ? ' or ' : null}
                    {config.contactPhone ? (
                      <a href={`tel:${config.contactPhone}`}>{config.contactPhone}</a>
                    ) : null}
                    {'. '}
                  </>
                ) : (
                  // No contact details on file — without this line the card is a dead end.
                  <>
                    Mention it to {config.displayName} next time you talk so they can set a
                    rate.{' '}
                  </>
                )}
                You can also book one pet at a time — just untick the others above.
              </p>
            </div>
          )}
        </div>
      )}
      {/* Rendered outside the details panel: submitting resets the dates, which unmounts
          the panel — a confirmation inside it would vanish before it was ever seen. */}
      {confirmation && <p className="bp-confirm">{confirmation}</p>}
      {/* Always-mounted live region so screen readers hear the quote and the outcome of
          "Request Booking" — the visual lines above are plain DOM updates and say nothing. */}
      <div className="bp-sr-only" role="status" aria-live="polite">
        {srStatus(confirmation, noteLine, unpriced, quoting, quote, config.displayName)}
      </div>
    </div>
  );
}

/** The single spoken version of everything the sighted customer can see below the button. */
function srStatus(
  confirmation: string,
  noteLine: string,
  unpriced: boolean,
  quoting: boolean,
  quote: Availability | null,
  displayName: string,
): string {
  if (confirmation) return confirmation;
  if (noteLine) return noteLine;
  if (unpriced) return `${displayName} hasn't set a price for this group of pets.`;
  if (quoting || !quote) return '';
  if (quote.available && quote.priced) {
    const units =
      quote.billedUnits != null && quote.unit != null
        ? `${quote.billedUnits} ${quote.unit}${quote.billedUnits === 1 ? '' : 's'}, `
        : '';
    return `${units}$${quote.estCost}.`;
  }
  return '';
}
