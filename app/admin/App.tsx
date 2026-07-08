import { type ReactNode, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { adminApi, isAuthExpired, type Customer } from '../shared-ui/api.js';
import {
  IconCalendar,
  IconClipboardCheck,
  IconCode,
  IconPaw,
  IconPlug,
  IconStore,
  IconTag,
  IconUsers,
} from '../shared-ui/icons';
import { AppsSection } from './sections/AppsSection';
import { BookingsSection } from './sections/BookingsSection';
import { BusinessSection } from './sections/BusinessSection';
import { ClientsSection } from './sections/ClientsSection';
import { EmbedSection } from './sections/EmbedSection';
import { PetsSection } from './sections/PetsSection';
import { ServicesSection } from './sections/ServicesSection';
import { TimeOffSection } from './sections/TimeOffSection';
import {
  adminFetch,
  type ServiceOptionForm,
  type ServicePayload,
  type Session,
  type Settings,
  type SettingsPayload,
} from './shared.js';
import './admin.css';
import { useAsync } from '../shared-ui/useAsync';

/**
 * Sitter dashboard. Auth is email + password → an admin session token, held in localStorage
 * (this is a first-party page the sitter visits directly, not the cross-origin embed widget).
 * The tenant slug comes from the session, not the URL — the sitter never types it.
 */

const TOKEN_KEY = 'pawbook-admin-token';

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
    <div className="pb-wrap pb-login">
      <h1>Welcome back</h1>
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
      {error && <p className="pb-error">{error}</p>}
    </div>
  );
}

type SectionKey =
  'bookings' | 'business' | 'pets' | 'services' | 'timeoff' | 'clients' | 'apps' | 'embed';

const SECTIONS: { key: SectionKey; label: string; icon: typeof IconStore }[] = [
  { key: 'bookings', label: 'Bookings', icon: IconClipboardCheck },
  { key: 'business', label: 'Business', icon: IconStore },
  { key: 'pets', label: 'Pet types', icon: IconPaw },
  { key: 'services', label: 'Services & rates', icon: IconTag },
  { key: 'timeoff', label: 'Time off', icon: IconCalendar },
  { key: 'clients', label: 'Clients', icon: IconUsers },
  { key: 'apps', label: 'Connected apps', icon: IconPlug },
  { key: 'embed', label: 'Your website', icon: IconCode },
];

/** Reads the initial section from the URL hash (e.g. `/admin#clients`) so deep links and page
 * refreshes land on the right section, same as the old anchor-nav did. */
function sectionFromHash(): SectionKey {
  const hash = window.location.hash.slice(1);
  // Default to Bookings — the sitter's morning question is "what needs my reply?",
  // not their own settings.
  return SECTIONS.some((s) => s.key === hash) ? (hash as SectionKey) : 'bookings';
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const { token, slug } = session;
  const [settings, setSettings] = useState<Settings | null>(null);
  // JSON snapshot of the last server-loaded/saved settings; edits compare against it to
  // decide whether the sticky save bar shows. Only the settings PUT is deferred — the
  // other sections apply immediately and refresh both state and snapshot together.
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // Bumped after a successful save so the embed preview remounts and pulls the fresh config.
  const [previewKey, setPreviewKey] = useState(0);
  const [activeSection, setActiveSection] = useState<SectionKey>(sectionFromHash);

  const dirty = settings !== null && JSON.stringify(settings) !== savedSnapshot;

  // The sticky sidebar nav docks just below the topbar, but the topbar's height isn't fixed —
  // it wraps to two lines for a long business name on a narrow viewport. Measure it instead of
  // guessing, so the sidebar never overlaps it. A callback ref (not useRef + an empty-deps
  // effect) because the header doesn't exist yet on the first render — this component returns
  // the "Loading…" paragraph below until `settings` arrives. useLayoutEffect (not useEffect) so
  // the measurement applies before paint — no flash of the pre-JS 78px fallback.
  const [topbarEl, setTopbarEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Scoped to the dashboard's own wrapper (the topbar's parent, also an ancestor of
    // .pb-sidenav) rather than the document root, so this doesn't leak global state that could
    // go stale for anything else that might ever read a same-named custom property.
    const wrap = topbarEl?.parentElement;
    if (!wrap) return;
    const setHeight = () => wrap.style.setProperty('--topbar-h', `${topbarEl.offsetHeight}px`);
    setHeight();
    const observer = new ResizeObserver(setHeight);
    observer.observe(topbarEl);
    return () => observer.disconnect();
  }, [topbarEl]);

  // Keeps the active section in sync with browser back/forward through the hash history
  // entries that switching sections now creates.
  useEffect(() => {
    const onHashChange = () => {
      setActiveSection(sectionFromHash());
      // An error banner describes the action just attempted; carrying it into another
      // section reads as a live, unexplained failure there.
      setError('');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // The saved confirmation is transient; errors stay until resolved.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 10000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const handle = useCallback(
    (e: unknown) => {
      if (isAuthExpired(e)) onSignOut();
      else setError(e instanceof Error ? e.message : 'Try again.');
    },
    [onSignOut],
  );

  /** Clear the error, run `fn`, and route any failure (including expired auth) through `handle`. */
  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      handle(e);
    }
  };

  const loadSettings = useCallback(
    () => adminFetch<Settings>(token, `/api/${slug}/admin/settings`),
    [token, slug],
  );

  const applyLoaded = useCallback((s: Settings) => {
    setSettings(s);
    setSavedSnapshot(JSON.stringify(s));
  }, []);

  const refresh = () => run(async () => applyLoaded(await loadSettings()));

  const save = () =>
    run(async () => {
      if (!settings) return;
      setMessage('');
      // Explicit per-field object literals (rather than spreading `s`/`o`) checked against
      // `ServicePayload`/`ServiceOptionForm` — annotated so a field added to the shared
      // option/question/constraint shapes fails to compile here instead of quietly not
      // reaching the wire (see e.g. the startTime/endTime/capacity fields).
      const payload: SettingsPayload = {
        displayName: settings.displayName,
        accentColor: settings.accentColor,
        maxBoardingPets: settings.maxBoardingPets,
        maxHouseSitsPerDay: settings.maxHouseSitsPerDay,
        maxStayNights: settings.maxStayNights,
        timezone: settings.timezone,
        contactEmail: settings.contactEmail,
        contactPhone: settings.contactPhone,
        petTypes: settings.petTypes.filter((p) => p.enabled).map((p) => p.petType),
        services: settings.services.map((s): ServicePayload => ({
          type: s.type,
          enabled: s.enabled,
          options: s.options.map((o): ServiceOptionForm => ({
            optionKey: o.optionKey,
            label: o.label,
            durationMinutes: s.hasDuration ? o.durationMinutes : null,
            rate: o.rate,
            startTime: o.startTime,
            endTime: o.endTime,
            capacity: o.capacity,
          })),
          questions: s.questions,
          minNights: s.minNights,
          maxNights: s.maxNights,
          minPetCount: s.minPetCount,
          maxPetCount: s.maxPetCount,
        })),
      };
      await adminFetch(token, `/api/${slug}/admin/settings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setMessage('Saved! Your widget updates on its next load.');
      setSavedSnapshot(JSON.stringify(settings));
      setPreviewKey((k) => k + 1);
    });

  const connectCalendar = () =>
    run(async () => {
      const { url } = await adminApi.calendar.start(slug, token);
      const popup = window.open(url, 'pawbook-gcal', 'width=520,height=640');
      // The callback page is script-free (CSP), so detect the popup closing here and re-fetch
      // settings to pick up the new connected status.
      const timer = window.setInterval(() => {
        if (!popup || popup.closed) {
          window.clearInterval(timer);
          void refresh();
        }
      }, 1000);
    });

  const disconnectCalendar = () =>
    run(async () => {
      await adminApi.calendar.disconnect(slug, token);
      await refresh();
    });

  const loadCustomers = useCallback(async (): Promise<Customer[]> => {
    try {
      const { customers: list } = await adminApi.customers.list(slug, token);
      return list;
    } catch (e) {
      // Route through the shared handler (error banner / sign-out on expired auth), but still
      // reject so useAsync keeps the last-known list instead of blanking it under the banner.
      handle(e);
      throw e;
    }
  }, [slug, token, handle]);

  const { data: customers, reload: reloadCustomers } = useAsync(loadCustomers);

  // Initial settings load: setState only inside the promise callback (react-hooks rule).
  useEffect(() => {
    let active = true;
    loadSettings()
      .then((s) => active && applyLoaded(s))
      .catch((e) => active && handle(e));
    return () => {
      active = false;
    };
  }, [loadSettings, handle, applyLoaded]);

  if (!settings) return <p className="pb-wrap">Loading…</p>;

  const enabledPetTypes = settings.petTypes.filter((p) => p.enabled).map((p) => p.petType);

  const panels: Record<SectionKey, ReactNode> = {
    bookings: (
      <BookingsSection session={session} handleError={handle} clearError={() => setError('')} />
    ),
    business: <BusinessSection settings={settings} setSettings={setSettings} />,
    pets: <PetsSection settings={settings} setSettings={setSettings} />,
    services: <ServicesSection settings={settings} setSettings={setSettings} />,
    timeoff: (
      <TimeOffSection
        blocked={settings.blocked}
        slug={slug}
        token={token}
        onChanged={refresh}
        handleError={handle}
        clearError={() => setError('')}
      />
    ),
    clients: (
      <ClientsSection
        customers={customers ?? []}
        enabledPetTypes={enabledPetTypes}
        slug={slug}
        token={token}
        onCustomersChanged={reloadCustomers}
        handleError={handle}
        clearError={() => setError('')}
      />
    ),
    apps: (
      <AppsSection
        calendar={settings.calendar}
        slug={slug}
        token={token}
        connectCalendar={connectCalendar}
        disconnectCalendar={disconnectCalendar}
        onCalendarSaved={() => void refresh()}
        handleError={handle}
      />
    ),
    embed: (
      <EmbedSection session={session} previewKey={previewKey} active={activeSection === 'embed'} />
    ),
  };

  return (
    <div className="pb-wrap pb-dash">
      <header className="pb-topbar" ref={setTopbarEl}>
        <div className="pb-topbar-row">
          <h1>{settings.displayName}</h1>
          <button className="pb-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="pb-layout">
        <nav className="pb-sidenav" aria-label="Sections">
          {SECTIONS.map(({ key, label, icon: Icon }) => (
            <a
              key={key}
              href={`#${key}`}
              className={key === activeSection ? 'pb-sidenav-active' : ''}
              aria-current={key === activeSection ? 'page' : undefined}
            >
              <Icon size={16} /> {label}
            </a>
          ))}
        </nav>

        {/* Every section stays mounted (just hidden) so in-progress edits — e.g. a typed-but-
            unsaved Google Calendar ID — and the embed preview iframe survive switching tabs.
            Rendered from SECTIONS (not a hand-listed div per key) so a section can't end up in
            the nav with no matching panel, or vice versa. */}
        <div className="pb-panel pb-card">
          {SECTIONS.map(({ key }) => (
            <div key={key} hidden={activeSection !== key}>
              {panels[key]}
            </div>
          ))}
        </div>
      </div>

      {(dirty || message || error) && (
        <div className="pb-savebar" role="status">
          {error ? (
            <p className="pb-savebar-error">{error}</p>
          ) : dirty ? (
            <p>You have unsaved changes.</p>
          ) : (
            <p className="pb-savebar-saved">{message}</p>
          )}
          {dirty && <button onClick={save}>Save settings</button>}
        </div>
      )}
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

  if (restoring) return <p className="pb-wrap">Loading…</p>;
  if (!session) return <Login onLogin={setSession} />;
  return <Dashboard session={session} onSignOut={signOut} />;
}
