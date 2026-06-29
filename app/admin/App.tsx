import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import './admin.css';

/**
 * Sitter dashboard. Auth is email + password → an admin session token, held in localStorage
 * (this is a first-party page the sitter visits directly, not the cross-origin embed widget).
 * The tenant slug comes from the session, not the URL — the sitter never types it.
 */

type Session = { token: string; slug: string; displayName: string };

const TOKEN_KEY = 'pawbook-admin-token';

/** A nullable capacity/limit input: blank ⇒ null (no limit), a number ⇒ that value. */
function NullableNumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label>
      {label} <span className="ad-hint">(blank = no limit)</span>
      <input
        type="number"
        min={1}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </label>
  );
}

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage denied — session lasts the page lifetime only */
  }
}

type ServiceOptionForm = {
  optionKey?: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
};
type ServiceForm = {
  type: string;
  label: string;
  hasDuration: boolean;
  rateUnit: string;
  enabled: boolean;
  options: ServiceOptionForm[];
};
type Settings = {
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  petTypes: { petType: string; enabled: boolean }[];
  services: ServiceForm[];
  blocked: { id: string; startDate: string; endDate: string | null }[];
  providers: {
    capability: string;
    provider: string;
    label: string;
    status: string;
    connectedAt: string | null;
  }[];
};

class AuthError extends Error {}

async function adminFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) throw new AuthError('Your session expired.');
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? 'Request failed.');
  return body;
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        slug?: string;
        displayName?: string;
        error?: string;
      };
      if (!res.ok || !body.token || !body.slug) {
        setError(body.error ?? 'Invalid email or password.');
        return;
      }
      storeToken(body.token);
      onLogin({
        token: body.token,
        slug: body.slug,
        displayName: body.displayName ?? body.slug,
      });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ad-wrap ad-login">
      <h1>Sitter sign in</h1>
      <label>
        Email
        <input
          type="email"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <button onClick={submit} disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="ad-error">{error}</p>}
      <p className="ad-hint">
        <small>Demo logins are in the app's DEMO_NOTES.md.</small>
      </p>
    </div>
  );
}

function Snippets({ session }: { session: Session }) {
  const [snippets, setSnippets] = useState<{
    script: string;
    iframe: string;
  } | null>(null);

  useEffect(() => {
    adminFetch<{ script: string; iframe: string }>(
      session.token,
      `/api/${session.slug}/admin/snippet`,
    )
      .then((s) => setSnippets(s))
      .catch(() => setSnippets(null));
  }, [session]);

  if (!snippets) return <p>Loading…</p>;
  return (
    <div>
      <p>
        <strong>Squarespace</strong> (Code Block, Core plan or higher) and most sites — paste this
        auto-resizing snippet:
      </p>
      <textarea readOnly rows={3} value={snippets.script} onFocus={(e) => e.target.select()} />
      <p>
        <strong>Wix</strong> ("Embed a site") and script-stripping hosts — use the plain iframe
        (fixed height, scrolls internally):
      </p>
      <textarea readOnly rows={3} value={snippets.iframe} onFocus={(e) => e.target.select()} />
    </div>
  );
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const { token, slug } = session;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [blockStart, setBlockStart] = useState('');
  const [blockEnd, setBlockEnd] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) onSignOut();
      else setError(e instanceof Error ? e.message : 'Try again.');
    },
    [onSignOut],
  );

  const loadSettings = useCallback(
    () => adminFetch<Settings>(token, `/api/${slug}/admin/settings`),
    [token, slug],
  );

  const refresh = async () => {
    setError('');
    try {
      setSettings(await loadSettings());
    } catch (e) {
      handle(e);
    }
  };

  const save = async () => {
    if (!settings) return;
    setError('');
    setMessage('');
    try {
      await adminFetch(token, `/api/${slug}/admin/settings`, {
        method: 'PUT',
        body: JSON.stringify({
          displayName: settings.displayName,
          accentColor: settings.accentColor,
          maxBoardingPets: settings.maxBoardingPets,
          maxHouseSitsPerDay: settings.maxHouseSitsPerDay,
          maxStayNights: settings.maxStayNights,
          timezone: settings.timezone,
          petTypes: settings.petTypes.filter((p) => p.enabled).map((p) => p.petType),
          services: settings.services.map((s) => ({
            type: s.type,
            enabled: s.enabled,
            options: s.options.map((o) => ({
              label: o.label,
              durationMinutes: s.hasDuration ? o.durationMinutes : null,
              rate: o.rate,
            })),
          })),
        }),
      });
      setMessage('Saved — the widget reflects this on next load.');
    } catch (e) {
      handle(e);
    }
  };

  const addBlock = async () => {
    setError('');
    try {
      await adminFetch(token, `/api/${slug}/admin/blocked`, {
        method: 'POST',
        body: JSON.stringify({ startDate: blockStart, endDate: blockEnd }),
      });
      setBlockStart('');
      setBlockEnd('');
      await refresh();
    } catch (e) {
      handle(e);
    }
  };

  const removeBlock = async (id: string) => {
    setError('');
    try {
      await adminFetch(token, `/api/${slug}/admin/blocked/${id}`, {
        method: 'DELETE',
      });
      await refresh();
    } catch (e) {
      handle(e);
    }
  };

  const connect = async (capability: string) => {
    setError('');
    try {
      await adminFetch(token, `/api/${slug}/admin/providers/${capability}/connect`, {
        method: 'POST',
      });
      await refresh();
    } catch (e) {
      handle(e);
    }
  };

  // Initial settings load: setState only inside the promise callback (react-hooks rule).
  useEffect(() => {
    let active = true;
    loadSettings()
      .then((s) => active && setSettings(s))
      .catch((e) => active && handle(e));
    return () => {
      active = false;
    };
  }, [loadSettings, handle]);

  if (!settings) return <p className="ad-wrap">Loading…</p>;

  return (
    <div className="ad-wrap">
      <header className="ad-topbar">
        <h1>{settings.displayName} — admin</h1>
        <button className="ad-signout" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <section>
        <h2>Branding &amp; capacity</h2>
        <label>
          Display name
          <input
            value={settings.displayName}
            onChange={(e) => setSettings({ ...settings, displayName: e.target.value })}
          />
        </label>
        <label>
          Accent color
          <input
            type="color"
            value={settings.accentColor}
            onChange={(e) => setSettings({ ...settings, accentColor: e.target.value })}
          />
        </label>
        <NullableNumberField
          label="Max boarding pets per day"
          value={settings.maxBoardingPets}
          onChange={(maxBoardingPets) => setSettings({ ...settings, maxBoardingPets })}
        />
        <NullableNumberField
          label="Max house-sits per day"
          value={settings.maxHouseSitsPerDay}
          onChange={(maxHouseSitsPerDay) => setSettings({ ...settings, maxHouseSitsPerDay })}
        />
        <NullableNumberField
          label="Max stay length (nights)"
          value={settings.maxStayNights}
          onChange={(maxStayNights) => setSettings({ ...settings, maxStayNights })}
        />
        <label>
          Business timezone <span className="ad-hint">(blank = {DEFAULT_TIMEZONE})</span>
          <input
            type="text"
            placeholder={DEFAULT_TIMEZONE}
            value={settings.timezone ?? ''}
            onChange={(e) =>
              setSettings({
                ...settings,
                timezone: e.target.value === '' ? null : e.target.value,
              })
            }
          />
        </label>
      </section>

      <section>
        <h2>Pets you care for</h2>
        {settings.petTypes.map((p, i) => (
          <label className="ad-inline" key={p.petType}>
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => {
                const petTypes = [...settings.petTypes];
                petTypes[i] = { ...p, enabled: e.target.checked };
                setSettings({ ...settings, petTypes });
              }}
            />
            {p.petType === 'dog' ? 'Dogs' : 'Cats'}
          </label>
        ))}
      </section>

      <section>
        <h2>Services &amp; rates</h2>
        {settings.services.map((s, si) => {
          const setService = (next: ServiceForm) => {
            const services = [...settings.services];
            services[si] = next;
            setSettings({ ...settings, services });
          };
          return (
            <div className="ad-service" key={s.type}>
              <label className="ad-inline">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => setService({ ...s, enabled: e.target.checked })}
                />
                {s.label}
              </label>
              {!s.hasDuration ? (
                <label className="ad-inline">
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
                <div className="ad-options">
                  {s.options.map((o, oi) => (
                    <div className="ad-inline" key={oi}>
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
            </div>
          );
        })}
      </section>

      <button className="ad-save" onClick={save}>
        Save settings
      </button>
      {message && <p className="ad-ok">{message}</p>}
      {error && <p className="ad-error">{error}</p>}

      <section>
        <h2>Blocked days</h2>
        <ul>
          {settings.blocked.map((b) => (
            <li key={b.id}>
              {b.startDate} → {b.endDate} (end exclusive){' '}
              <button onClick={() => void removeBlock(b.id)}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="ad-inline">
          <input type="date" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
          <input type="date" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
          <button onClick={addBlock}>Block range</button>
        </div>
      </section>

      <section>
        <h2>Integrations (prototype stubs)</h2>
        <ul>
          {settings.providers.map((p) => (
            <li key={p.capability}>
              {p.label} — <em>{p.status}</em>{' '}
              {p.status === 'disconnected' && (
                <button onClick={() => void connect(p.capability)}>Connect (stub)</button>
              )}
            </li>
          ))}
        </ul>
        <p>
          <small>No real OAuth happens here — connecting only flips persisted state.</small>
        </p>
      </section>

      <section id="embed">
        <h2>Embed on your website</h2>
        <Snippets session={session} />
      </section>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  // Seed from token presence so the no-token path needs no synchronous setState in the effect.
  const [restoring, setRestoring] = useState(() => getStoredToken() !== null);

  const signOut = useCallback(() => {
    storeToken(null);
    setSession(null);
  }, []);

  // Restore a stored session on load by validating the token (setState only in promise callbacks).
  useEffect(() => {
    document.title = 'Sitter dashboard';
    const token = getStoredToken();
    if (!token) return;
    let active = true;
    fetch('/api/admin/session', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!active) return;
        if (res.ok) {
          const body = (await res.json()) as {
            slug: string;
            displayName: string;
          };
          setSession({ token, slug: body.slug, displayName: body.displayName });
        } else {
          storeToken(null);
        }
      })
      .catch(() => {})
      .finally(() => active && setRestoring(false));
    return () => {
      active = false;
    };
  }, []);

  if (restoring) return <p className="ad-wrap">Loading…</p>;
  if (!session) return <Login onLogin={setSession} />;
  return <Dashboard session={session} onSignOut={signOut} />;
}
