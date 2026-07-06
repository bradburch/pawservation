import {
  formatShortDate,
  nightsBetween,
  validateAnswers,
  validateServiceConstraints,
} from '../../src/shared/index.js';
import { useCallback, useEffect, useState } from 'react';
import { Calendar } from './Calendar';
import {
  api,
  getToken,
  isAuthExpired,
  setToken,
  type Availability,
  type Booking,
  type Pet,
  type ServiceQuestion,
  type TenantConfig,
} from '../shared-ui/api';
import './widget.css';
import { SERVICE_ICONS } from './services';
import { IconCheck, IconPaw } from '../shared-ui/icons';

const errorMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Try again.');

function QuestionField({
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

/** Widget tenant comes from the iframe path: /embed/:slug — never from the host page. */
const slug = window.location.pathname.split('/').filter(Boolean)[1] ?? '';

type IdentifyState =
  | { step: 'email' }
  | { step: 'code'; codeId: string; prototypeCode?: string; email: string };

function Identify({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<IdentifyState>({ step: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitEmail = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.identify(slug, email);
      setState({
        step: 'code',
        codeId: res.codeId,
        prototypeCode: res.prototypeCode,
        email,
      });
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (state.step !== 'code') return;
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.verify(slug, state.codeId, code);
      setToken(slug, res.token);
      onDone();
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (state.step === 'email') {
    return (
      <div className="bp-identify">
        <label className="bp-field">
          Your email
          <input
            type="email"
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitEmail()}
          />
        </label>
        <button onClick={submitEmail} disabled={busy}>
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
        {error && <p className="bp-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bp-identify">
      <p className="bp-proto-code">
        {state.prototypeCode ? (
          <>
            Your code: <strong>{state.prototypeCode}</strong>
            <br />
            <small>(dev mode: this would be emailed to {state.email})</small>
          </>
        ) : (
          <>
            We emailed a 6-digit code to <strong>{state.email}</strong>.
          </>
        )}
      </p>
      <input
        className="bp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        placeholder="······"
        aria-label="6-digit code"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
      />
      <button onClick={submitCode} disabled={busy}>
        {busy ? 'Verifying…' : 'Verify'}
      </button>
      {error && <p className="bp-error">{error}</p>}
    </div>
  );
}

function BookTab({
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
    setError('');
    setConfirmation('');
    setResult(null);
    if (selectedPets.length === 0) {
      setError('Choose at least one pet.');
      return;
    }
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
      window.parent.postMessage({ type: 'pawbook:booked', requestId: res.id }, '*');
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
          const Icon = SERVICE_ICONS[s.type] ?? IconPaw;
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
                  return (
                    <label className={`bp-pet-chip${on ? ' bp-on' : ''}`} key={p.id}>
                      <input
                        type="checkbox"
                        checked={on}
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
                      <span className="bp-pet-type">{p.petType}</span>
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
          <button onClick={check} disabled={selectedPets.length === 0}>
            Check availability
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
                  disabled={submitting || !!questionsError || !!constraintsError}
                >
                  {submitting ? 'Sending…' : 'Send request'}
                </button>
                {(questionsError || constraintsError) && (
                  <p className="bp-error">{questionsError ?? constraintsError}</p>
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

function MineTab() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  // Seed from token presence so the effect never sets state synchronously (react-hooks rule).
  const [needIdentify, setNeedIdentify] = useState(() => !getToken(slug));
  const [error, setError] = useState('');

  // Resolve the bookings load to a settled outcome, with NO setState — the caller applies it.
  // Keeping setState out of this function lets the effect call setState only inside a `.then`
  // callback (the shape react-hooks/set-state-in-effect blesses), not synchronously.
  const loadOutcome = useCallback(
    async (
      token: string,
    ): Promise<
      { kind: 'ok'; bookings: Booking[] } | { kind: 'reauth' } | { kind: 'error'; message: string }
    > => {
      try {
        const res = await api.myBookings(slug, token);
        return { kind: 'ok', bookings: res.bookings };
      } catch (e) {
        if (isAuthExpired(e)) {
          setToken(slug, null);
          return { kind: 'reauth' };
        }
        return {
          kind: 'error',
          message: errorMsg(e),
        };
      }
    },
    [],
  );

  const apply = useCallback((outcome: Awaited<ReturnType<typeof loadOutcome>>) => {
    if (outcome.kind === 'ok') {
      setBookings(outcome.bookings);
      setNeedIdentify(false);
    } else if (outcome.kind === 'reauth') {
      setNeedIdentify(true);
    } else {
      setError(outcome.message);
    }
  }, []);

  const reload = () => {
    const token = getToken(slug);
    if (token) void loadOutcome(token).then(apply);
    else setNeedIdentify(true);
  };

  useEffect(() => {
    const token = getToken(slug);
    if (!token) return;
    let active = true;
    void loadOutcome(token).then((outcome) => {
      if (active) apply(outcome);
    });
    return () => {
      active = false;
    };
  }, [loadOutcome, apply]);

  if (needIdentify) return <Identify onDone={reload} />;
  if (error) return <p className="bp-error">{error}</p>;
  if (!bookings) return <p>Loading…</p>;
  if (bookings.length === 0) return <p>No bookings yet — book one above!</p>;

  return (
    <ul className="bp-mine">
      {bookings.map((b) => (
        <li key={b.id}>
          <span className="bp-mine-main">
            <strong>{b.type}</strong> {formatShortDate(b.startDate)}
            {b.endDate ? ` – ${formatShortDate(b.endDate)}` : ''} ·{' '}
            {b.pets.length > 0
              ? b.pets.join(', ')
              : `${b.petCount} pet${b.petCount === 1 ? '' : 's'}`}
            {b.estCost != null ? ` · est. $${b.estCost}` : ''}
          </span>
          <em>{b.status}</em>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [me, setMe] = useState<{ name: string | null; pets: Pet[] } | null>(null);
  const [authed, setAuthed] = useState(() => !!getToken(slug));
  const [error, setError] = useState('');
  const [showMine, setShowMine] = useState(false);

  // Report content height to the parent loader so the iframe auto-resizes (story 3.1).
  useEffect(() => {
    const report = () =>
      window.parent.postMessage(
        // No secrets ever cross postMessage; the loader filters by origin + source.
        {
          type: 'pawbook:resize',
          height: document.documentElement.scrollHeight,
        },
        '*',
      );
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    api
      .config(slug)
      .then((c) => {
        setConfig(c);
        document.documentElement.style.setProperty('--bp-accent', c.accentColor);
        document.title = `Book with ${c.displayName}`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, []);

  // Any 401/403 means the stored token is expired or revoked: clear it and drop back to
  // sign-in ("token loss must degrade to re-identify" — server/lib/token.ts). Without this
  // the booking view renders with a dead calendar that silently ignores taps.
  const onAuthExpired = useCallback(() => {
    setToken(slug, null);
    setMe(null);
    setAuthed(false);
  }, []);

  useEffect(() => {
    if (!authed) return;
    const token = getToken(slug);
    if (!token) return;
    let active = true;
    api
      .me(slug, token)
      .then((m) => active && setMe(m))
      .catch((e: unknown) => {
        if (!active) return;
        if (isAuthExpired(e)) onAuthExpired();
        else setMe({ name: null, pets: [] });
      });
    return () => {
      active = false;
    };
  }, [authed, onAuthExpired]);

  if (error) return <p className="bp-error">{error}</p>;
  if (!config) return <p>Loading…</p>;

  if (!authed) {
    return (
      <div className="bp-widget">
        <h1 className="bp-greeting">Book with {config.displayName}</h1>
        <p className="bp-signin-lede">
          Enter the email your sitter has on file and we&apos;ll send you a sign-in code.
        </p>
        <Identify onDone={() => setAuthed(true)} />
      </div>
    );
  }

  const firstName = (me?.name ?? '').trim().split(/\s+/)[0] || 'there';
  return (
    <div className="bp-widget bp-book-view">
      <div className="bp-topline">
        <button className="bp-mine-link" onClick={() => setShowMine((s) => !s)}>
          {showMine ? '← Book' : 'My bookings'}
        </button>
      </div>
      {showMine ? (
        <>
          <h1 className="bp-greeting">Your bookings</h1>
          <MineTab />
        </>
      ) : (
        <>
          <h1 className="bp-greeting">How can I help, {firstName}?</h1>
          <BookTab config={config} pets={me?.pets ?? null} onAuthExpired={onAuthExpired} />
        </>
      )}
    </div>
  );
}
