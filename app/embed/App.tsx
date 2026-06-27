import { formatShortDate } from '../../src/shared/index.js';
import { useCallback, useEffect, useState } from 'react';

const errorMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Try again.');
import {
  api,
  ApiError,
  getToken,
  setToken,
  type Availability,
  type Booking,
  type TenantConfig,
} from '../shared-ui/api';
import './widget.css';

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

  const submitEmail = async () => {
    setError('');
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
    }
  };

  const submitCode = async () => {
    if (state.step !== 'code') return;
    setError('');
    try {
      const res = await api.verify(slug, state.codeId, code);
      setToken(slug, res.token);
      onDone();
    } catch (e) {
      setError(errorMsg(e));
    }
  };

  if (state.step === 'email') {
    return (
      <div className="bp-identify">
        <p>Enter your email to continue:</p>
        <input
          type="email"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
        />
        <button onClick={submitEmail}>Send code</button>
        {error && <p className="bp-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bp-identify">
      {state.prototypeCode ? (
        <p className="bp-proto-code">
          Your code: <strong>{state.prototypeCode}</strong>
          <br />
          <small>(dev mode: this would be emailed to {state.email})</small>
        </p>
      ) : (
        <p className="bp-proto-code">
          We emailed a 6-digit code to <strong>{state.email}</strong>.
        </p>
      )}
      <input
        inputMode="numeric"
        value={code}
        placeholder="6-digit code"
        onChange={(e) => setCode(e.target.value)}
      />
      <button onClick={submitCode}>Verify</button>
      {error && <p className="bp-error">{error}</p>}
    </div>
  );
}

function BookTab({ config }: { config: TenantConfig }) {
  const [type, setType] = useState(config.services[0]?.type ?? 'boarding');
  const service = config.services.find((s) => s.type === type) ?? config.services[0];
  const [optionKey, setOptionKey] = useState(service?.options[0]?.optionKey ?? '');
  const [petType, setPetType] = useState(config.petTypes[0] ?? '');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [pets, setPets] = useState(1);
  const [result, setResult] = useState<Availability | null>(null);
  const [needIdentify, setNeedIdentify] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const resetCheck = () => {
    setResult(null);
    setConfirmation('');
  };

  const onServiceChange = (next: string) => {
    setType(next);
    const svc = config.services.find((s) => s.type === next);
    setOptionKey(svc?.options[0]?.optionKey ?? '');
    resetCheck();
  };

  const check = async () => {
    setError('');
    setConfirmation('');
    setResult(null);
    try {
      const params: Record<string, string> = {
        type,
        option: optionKey,
        start,
        pets: String(pets),
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
    if (!token) {
      setNeedIdentify(true);
      return;
    }
    setSubmitting(true);
    try {
      const body: {
        type: string;
        optionKey: string;
        petType?: string;
        startDate: string;
        endDate?: string;
        petCount: number;
      } = { type, optionKey, startDate: start, petCount: pets };
      if (petType) body.petType = petType;
      if (service?.shape === 'range') body.endDate = end;
      const res = await api.createBooking(slug, token, body);
      setConfirmation(`Request sent! Estimated cost $${res.estCost}. Status: ${res.status}.`);
      setResult(null);
      window.parent.postMessage({ type: 'pawbook:booked', requestId: res.id }, '*');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setToken(slug, null);
        setNeedIdentify(true);
        return;
      }
      setError(errorMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (needIdentify) {
    return (
      <Identify
        onDone={() => {
          setNeedIdentify(false);
          void submit();
        }}
      />
    );
  }

  if (!service) return <p>No services offered yet.</p>;

  return (
    <div className="bp-book">
      <label>
        Service
        <select value={type} onChange={(e) => onServiceChange(e.target.value)}>
          {config.services.map((s) => {
            const min = Math.min(...s.options.map((o) => o.rate));
            return (
              <option key={s.type} value={s.type}>
                {`${s.label} — from $${min}/${s.rateUnit}`}
              </option>
            );
          })}
        </select>
      </label>

      {service.hasDuration && (
        <label>
          Duration
          <select
            value={optionKey}
            onChange={(e) => {
              setOptionKey(e.target.value);
              resetCheck();
            }}
          >
            {service.options.map((o) => (
              <option key={o.optionKey} value={o.optionKey}>
                {`${o.label} — $${o.rate}/${service.rateUnit}`}
              </option>
            ))}
          </select>
        </label>
      )}

      {config.petTypes.length > 0 && (
        <label>
          Pet
          <select
            value={petType}
            onChange={(e) => {
              setPetType(e.target.value);
              resetCheck();
            }}
          >
            {config.petTypes.map((p) => (
              <option key={p} value={p}>
                {p === 'dog' ? 'Dog' : 'Cat'}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        {service.shape === 'range' ? 'Check-in' : 'Date'}
        <input
          type="date"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            resetCheck();
          }}
        />
      </label>
      {service.shape === 'range' && (
        <label>
          Checkout
          <input
            type="date"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              resetCheck();
            }}
          />
        </label>
      )}
      <label>
        Pets
        <input
          type="number"
          min={1}
          value={pets}
          onChange={(e) => {
            setPets(Number(e.target.value));
            resetCheck();
          }}
        />
      </label>
      <button onClick={check}>Check availability</button>

      {result &&
        (result.available ? (
          <div className="bp-result bp-ok">
            <p>
              Available!{' '}
              {result.nights != null
                ? `${result.nights} night${result.nights === 1 ? '' : 's'} · `
                : ''}
              Est. cost <strong>${result.estCost}</strong>
            </p>
            <button onClick={submit} disabled={submitting}>
              {submitting ? 'Sending…' : 'Confirm & request'}
            </button>
          </div>
        ) : (
          <div className="bp-result bp-no">
            <p>{result.reason}</p>
          </div>
        ))}
      {confirmation && <p className="bp-confirm">{confirmation}</p>}
      {error && <p className="bp-error">{error}</p>}
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
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
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
  if (bookings.length === 0) return <p>No bookings yet.</p>;

  return (
    <ul className="bp-mine">
      {bookings.map((b) => (
        <li key={b.id}>
          <strong>{b.type}</strong> {formatShortDate(b.startDate)}
          {b.endDate ? ` → ${formatShortDate(b.endDate)}` : ''} · {b.petCount} pet
          {b.petCount === 1 ? '' : 's'}
          {b.estCost != null ? ` · est. $${b.estCost}` : ''} · <em>{b.status}</em>
        </li>
      ))}
    </ul>
  );
}

/** Report content height to the parent loader so the iframe auto-resizes (story 3.1). */
function useResizeReporter() {
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
}

export default function App() {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [tab, setTab] = useState<'book' | 'mine'>('book');
  const [error, setError] = useState('');
  useResizeReporter();

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

  if (error) return <p className="bp-error">{error}</p>;
  if (!config) return <p>Loading…</p>;

  return (
    <div className="bp-widget">
      <header>
        <h1>{config.displayName}</h1>
        <nav>
          <button className={tab === 'book' ? 'bp-active' : ''} onClick={() => setTab('book')}>
            Book
          </button>
          <button className={tab === 'mine' ? 'bp-active' : ''} onClick={() => setTab('mine')}>
            My bookings
          </button>
        </nav>
      </header>
      {tab === 'book' ? <BookTab config={config} /> : <MineTab />}
    </div>
  );
}
