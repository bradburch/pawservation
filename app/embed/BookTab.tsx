import {
  formatShortDate,
  nightsBetween,
  validateAnswers,
  validatePetTypeAcceptance,
  validateServiceConstraints,
} from '../../src/shared/index.js';
import { useState } from 'react';
import { Calendar } from './Calendar';
import {
  api,
  getToken,
  isAuthExpired,
  type Availability,
  type Pet,
  type TenantConfig,
} from '../shared-ui/api';
import { IconCheck, IconPaw, SERVICE_ICONS } from '../shared-ui/icons';
import { QuestionField } from './QuestionField';
import { errorMsg, slug, parentOrigin } from './shared';

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
  const [selectedPets, setSelectedPets] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [calReloadKey, setCalReloadKey] = useState(0);
  const [result, setResult] = useState<Availability | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);

  const selectedOption = service?.options.find((o) => o.optionKey === optionKey);
  const petTypeLabels = new Map(config.petTypes.map((p) => [p.slug, p.label]));
  const labelOf = (petSlug: string) => petTypeLabels.get(petSlug) ?? petSlug;
  // Mirror of the server verdict: registry membership (slug present in config.petTypes — an
  // absent slug is corrupt/stale data) AND the service's own acceptance list (null = accepts all).
  const petAccepted = (p: Pet) =>
    petTypeLabels.has(p.petType) &&
    (!service?.acceptedPetTypes || service.acceptedPetTypes.includes(p.petType));
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
        {
          minNights: service.minNights,
          maxNights: service.maxNights,
          minPetCount: service.minPetCount,
          maxPetCount: service.maxPetCount,
        },
        { nights, petCount: selectedPets.length },
      )
    : null;

  const datesReady = !!start && (service?.shape !== 'range' || !!end);

  const resetCheck = () => {
    setResult(null);
    setConfirmation('');
  };

  const onServiceChange = (next: string) => {
    setType(next);
    const svc = config.services.find((s) => s.type === next);
    setOptionKey(svc?.options[0]?.optionKey ?? '');
    setStart('');
    setEnd('');
    setSelectedPets([]);
    setAnswers({});
    resetCheck();
  };

  const check = async () => {
    if (checking) return;
    setError('');
    setConfirmation('');
    setResult(null);
    if (selectedPets.length === 0) {
      setError('Choose at least one pet.');
      return;
    }
    setChecking(true);
    try {
      const params: Record<string, string> = {
        type,
        option: optionKey,
        start,
        pets: String(selectedPets.length),
      };
      if (service?.shape === 'range') params.end = end;
      setResult(await api.availability(slug, params));
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    if (submitting) return;
    setError('');
    const token = getToken(slug);
    if (!token) return;
    setSubmitting(true);
    try {
      const body = {
        type,
        optionKey,
        startDate: start,
        petIds: selectedPets,
        answers,
        ...(service?.shape === 'range' ? { endDate: end } : {}),
      };
      const res = await api.createBooking(slug, token, body);
      setConfirmation(
        `Request sent! Estimated cost $${res.estCost}. Track it under "My bookings".`,
      );
      setStart('');
      setEnd('');
      setSelectedPets([]);
      setAnswers({});
      setResult(null);
      setCalReloadKey((k) => k + 1);
      // Both families, for HTTP-cached pre-rebrand loaders (see the resize note in App.tsx):
      // the current loader handles `pawservation:booked`, legacy loaders handle `pawbook:booked`.
      for (const type of ['pawservation:booked', 'pawbook:booked']) {
        window.parent.postMessage({ type, requestId: res.id }, parentOrigin);
      }
    } catch (e) {
      if (isAuthExpired(e)) {
        onAuthExpired();
        return;
      }
      setError(errorMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!service) return <p>No services available yet.</p>;

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
              onClick={() => onServiceChange(s.type)}
            >
              <span className="bp-service-emoji" aria-hidden="true">
                <Icon />
              </span>
              <span className="bp-service-label">{s.label}</span>
            </button>
          );
        })}
      </div>

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

      <Calendar
        slug={slug}
        token={getToken(slug) ?? ''}
        serviceType={type}
        optionKey={optionKey}
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
          <fieldset className="bp-pets">
            <legend>Who&apos;s coming?</legend>
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
                          setSelectedPets((cur) =>
                            e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id),
                          );
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
          {service && service.questions.length > 0 && (
            <fieldset className="bp-questions">
              <legend>A few questions</legend>
              {service.questions.map((q) => (
                <QuestionField
                  key={q.id}
                  question={q}
                  value={answers[q.id] ?? ''}
                  onChange={(value) => setAnswers((cur) => ({ ...cur, [q.id]: value }))}
                />
              ))}
            </fieldset>
          )}
          <button onClick={check} disabled={selectedPets.length === 0 || checking}>
            {checking ? 'Checking…' : 'Check availability'}
          </button>
          {result &&
            (result.available ? (
              <div className="bp-summary">
                <p className="bp-summary-dates">
                  {formatShortDate(start)}
                  {end ? ` – ${formatShortDate(end)}` : ''}
                  {result.nights != null
                    ? ` · ${result.nights} night${result.nights === 1 ? '' : 's'}`
                    : ''}
                </p>
                <p className="bp-summary-cost">
                  Estimated cost <strong>${result.estCost}</strong>
                </p>
                <button
                  onClick={submit}
                  disabled={
                    submitting || !!questionsError || !!constraintsError || !!acceptanceError
                  }
                >
                  {submitting ? 'Sending…' : 'Send request'}
                </button>
                {(questionsError || constraintsError || acceptanceError) && (
                  <p className="bp-error">
                    {questionsError ?? constraintsError ?? acceptanceError}
                  </p>
                )}
              </div>
            ) : (
              <div className="bp-result bp-no">
                <p>{result.reason}</p>
              </div>
            ))}
          {error && <p className="bp-error">{error}</p>}
        </div>
      )}
      {/* Rendered outside the details panel: submitting resets the dates, which unmounts
          the panel — a confirmation inside it would vanish before it was ever seen. */}
      {confirmation && <p className="bp-confirm">{confirmation}</p>}
    </div>
  );
}
