import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { adminApi, isAuthExpired, type AdminBooking, type Customer } from '../shared-ui/api.js';
import {
  IconCalendar,
  IconChartBar,
  IconClipboardCheck,
  IconCode,
  IconHelp,
  IconPaw,
  IconPlug,
  IconStore,
  IconTag,
  IconUsers,
} from '../shared-ui/icons';
import { AppsSection } from './sections/AppsSection';
import { BookingsSection } from './sections/BookingsSection';
import { BusinessSection } from './sections/BusinessSection';
import { CalendarSection } from './sections/CalendarSection';
import { ClientsSection } from './sections/ClientsSection';
import { EarningsSection } from './sections/EarningsSection';
import { EmbedSection } from './sections/EmbedSection';
import { HelpSection } from './sections/HelpSection';
import { PetsSection } from './sections/PetsSection';
import { ServicesSection } from './sections/ServicesSection';
import { SetupWizard } from './SetupWizard';
import { TimeOffSection } from './sections/TimeOffSection';
import {
  adminFetch,
  type AnySession,
  type ServiceOptionForm,
  type ServicePayload,
  type Session,
  type Settings,
  type SettingsPayload,
} from './shared.js';
import './admin.css';
import { useAsync } from '../shared-ui/useAsync';
import { OwnerConsole } from './OwnerConsole';

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

function Login({ onLogin }: { onLogin: (s: AnySession) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // "New here?" — invite-signup kickoff. Always answers with the same neutral copy
  // (the server is enumeration-neutral; don't undo that in the UI).
  const [signupOpen, setSignupOpen] = useState(false);
  const [signupEmail, setSignupEmail] = useState('');
  const [signupSent, setSignupSent] = useState(false);
  const [prototypeLink, setPrototypeLink] = useState('');
  const [signupBusy, setSignupBusy] = useState(false);

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
        role?: 'admin' | 'owner';
        slug?: string;
        displayName?: string;
        email?: string;
        error?: string;
      };
      if (!res.ok || !body.token) {
        setError(body.error ?? 'Invalid email or password.');
        return;
      }
      storeToken(body.token);
      if (body.role === 'owner') {
        onLogin({ token: body.token, role: 'owner', email: body.email ?? email });
      } else if (body.slug) {
        onLogin({
          token: body.token,
          role: 'admin',
          slug: body.slug,
          displayName: body.displayName ?? body.slug,
        });
      } else {
        setError('Invalid email or password.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const startSignup = async () => {
    if (signupBusy) return;
    setError('');
    setSignupBusy(true);
    try {
      const res = await fetch('/api/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: signupEmail }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        prototypeLink?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? 'Try again.');
        return;
      }
      setSignupSent(true);
      setPrototypeLink(body.prototypeLink ?? '');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSignupBusy(false);
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
      <div className="pb-login-signup">
        {!signupOpen ? (
          <button type="button" className="pb-linklike" onClick={() => setSignupOpen(true)}>
            New here? Enter your email to get set up
          </button>
        ) : signupSent ? (
          <>
            <p>Check your email — if you&rsquo;ve been invited, a setup link is on its way.</p>
            {prototypeLink && (
              <p>
                {/* Dev only: the server includes prototypeLink when no email provider is
                    configured (mirrors the widget's prototypeCode). */}
                <a href={prototypeLink}>Open your setup link (dev)</a>
              </p>
            )}
          </>
        ) : (
          <>
            <label>
              Your email
              <input
                type="email"
                value={signupEmail}
                autoComplete="email"
                onChange={(e) => setSignupEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void startSignup()}
              />
            </label>
            <button type="button" onClick={startSignup} disabled={signupBusy}>
              {signupBusy ? 'Sending…' : 'Get set up'}
            </button>
          </>
        )}
      </div>
      {error && <p className="pb-error">{error}</p>}
    </div>
  );
}

type SectionKey =
  | 'calendar'
  | 'bookings'
  | 'earnings'
  | 'business'
  | 'pets'
  | 'services'
  | 'timeoff'
  | 'clients'
  | 'apps'
  | 'embed'
  | 'help';

const SECTIONS: { key: SectionKey; label: string; icon: typeof IconStore }[] = [
  { key: 'calendar', label: 'Calendar', icon: IconCalendar },
  { key: 'bookings', label: 'Bookings', icon: IconClipboardCheck },
  { key: 'earnings', label: 'Earnings', icon: IconChartBar },
  { key: 'business', label: 'Business', icon: IconStore },
  { key: 'pets', label: 'Pet types', icon: IconPaw },
  { key: 'services', label: 'Services & rates', icon: IconTag },
  { key: 'timeoff', label: 'Time off', icon: IconCalendar },
  { key: 'clients', label: 'Clients', icon: IconUsers },
  { key: 'apps', label: 'Connected apps', icon: IconPlug },
  { key: 'embed', label: 'Your website', icon: IconCode },
  { key: 'help', label: 'Help', icon: IconHelp },
];

/** Reads the initial section from the URL hash (e.g. `/admin#clients`) so deep links and page
 * refreshes land on the right section, same as the old anchor-nav did. */
function sectionFromHash(): SectionKey {
  const hash = window.location.hash.slice(1);
  // Default to Calendar — the sitter's morning question is "what needs my reply?", not their
  // own settings, and the calendar's grid + pending list answers that plus "what does my
  // month look like?" in one view.
  return SECTIONS.some((s) => s.key === hash) ? (hash as SectionKey) : 'calendar';
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
  const [wizardOpen, setWizardOpen] = useState(false);
  // Auto-open at most once per dashboard mount, so skipping it doesn't re-trigger on refresh().
  const wizardAutoOpened = useRef(false);
  // Chip deep-link handoff: CalendarSection sets this and navigates to #bookings;
  // BookingsSection scrolls the row into view, flashes it, then clears via onFocusConsumed.
  const [focusBookingId, setFocusBookingId] = useState<string | null>(null);

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

  // This dashboard-level sticky bar (unsaved changes / save error / saved confirmation) and
  // BookingList's own fixed confirmation bar (rendered inside .pb-panel — see BookingsSection
  // and CalendarSection, which both reuse it) are two independent `position: fixed; bottom: 0`
  // elements at the same z-index. Without coordination, this one — rendered later in the DOM —
  // paints over the booking confirmation, hiding its "couldn't email the client" notice and its
  // OK button. Measure this bar's height (same technique as --topbar-h above) and expose it as
  // --dash-savebar-h so admin.css can offset the booking bar to sit just above it instead of
  // underneath. Reset to 0px when this bar isn't showing, so the booking bar sits flush at the
  // bottom exactly as before in the common case where the two never overlap.
  const [dashSavebarEl, setDashSavebarEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const wrap = topbarEl?.parentElement;
    if (!wrap) return;
    if (!dashSavebarEl) {
      wrap.style.setProperty('--dash-savebar-h', '0px');
      return;
    }
    const setHeight = () =>
      wrap.style.setProperty('--dash-savebar-h', `${dashSavebarEl.offsetHeight}px`);
    setHeight();
    const observer = new ResizeObserver(setHeight);
    observer.observe(dashSavebarEl);
    return () => observer.disconnect();
  }, [dashSavebarEl, topbarEl]);

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

  /**
   * Updates only `settings.calendar` from a fresh GET, leaving every other field — including
   * whatever the sitter currently has staged and unsaved elsewhere on the page — untouched.
   * There's no narrower server endpoint for "just the calendar status" (and this fix adds none),
   * but `/admin/settings` already returns it as one field of the full payload, so the same
   * request `refresh()` uses can be narrowed entirely on the client by only merging that one
   * field into both `settings` and `savedSnapshot` (the latter so this fetch doesn't itself make
   * the page look dirty — see `dirty`'s definition above). Used by the calendar-connect popup
   * poll below, which used to call the full `refresh()` and blow away staged edits.
   */
  const refreshCalendarStatus = () =>
    run(async () => {
      const fresh = await loadSettings();
      setSettings((prev) => (prev ? { ...prev, calendar: fresh.calendar } : prev));
      setSavedSnapshot((prev) => {
        if (!prev) return prev;
        const parsed = JSON.parse(prev) as Settings;
        return JSON.stringify({ ...parsed, calendar: fresh.calendar });
      });
    });

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
        timezone: settings.timezone,
        contactEmail: settings.contactEmail,
        contactPhone: settings.contactPhone,
        services: settings.services.map((s): ServicePayload => ({
          type: s.type,
          enabled: s.enabled,
          maxConcurrentPets: s.maxConcurrentPets,
          maxPerDay: s.maxPerDay,
          options: s.options.map((o): ServiceOptionForm => ({
            optionKey: o.optionKey,
            label: o.label,
            durationMinutes: s.hasDuration ? o.durationMinutes : null,
            rate: o.rate,
            startTime: o.startTime,
            endTime: o.endTime,
            capacity: o.capacity,
            weekdaysOnly: o.weekdaysOnly,
          })),
          questions: s.questions,
          minNights: s.minNights,
          maxNights: s.maxNights,
          minPetCount: s.minPetCount,
          maxPetCount: s.maxPetCount,
          acceptedPetTypes: s.acceptedPetTypes,
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

  const addService = (template: string, label: string) =>
    run(async () => {
      await adminFetch(token, `/api/${slug}/admin/services`, {
        method: 'POST',
        body: JSON.stringify({ template, label }),
      });
      await refresh();
    });

  const removeService = (type: string) =>
    run(async () => {
      await adminFetch(token, `/api/${slug}/admin/services/${type}`, { method: 'DELETE' });
      await refresh();
    });

  const addPetType = (label: string) =>
    run(async () => {
      await adminFetch(token, `/api/${slug}/admin/pet-types`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      await refresh();
    });

  const renamePetType = (petType: string, label: string) =>
    run(async () => {
      await adminFetch(token, `/api/${slug}/admin/pet-types/${petType}`, {
        method: 'PUT',
        body: JSON.stringify({ label }),
      });
      await refresh();
    });

  const removePetType = (petType: string) =>
    run(async () => {
      const { disabledServices } = await adminFetch<{ disabledServices: string[] }>(
        token,
        `/api/${slug}/admin/pet-types/${petType}`,
        { method: 'DELETE' },
      );
      const fresh = await loadSettings();
      applyLoaded(fresh);
      // Emptying a service's accepted-pets list turns it off (never silently widens it to
      // "accepts everything") — tell the sitter which service(s) just went dark.
      if (disabledServices.length > 0) {
        const labels = disabledServices.map(
          (type) => fresh.services.find((s) => s.type === type)?.label ?? type,
        );
        const plural = labels.length > 1;
        setMessage(
          `${labels.join(', ')} no longer accept${plural ? '' : 's'} any pet type, so ${
            plural ? "they've" : "it's"
          } been turned off.`,
        );
      }
    });

  const connectCalendar = () =>
    run(async () => {
      const { url } = await adminApi.calendar.start(slug, token);
      const popup = window.open(url, 'pawbook-gcal', 'width=520,height=640');
      // The callback page is script-free (CSP), so detect the popup closing here and re-fetch
      // the connection status. Narrowed to just `calendar` (not the full refresh()) — this fires
      // on a timer detached from any user action (up to 1s after the popup actually closes, and
      // immediately if it was blocked), so it must not clobber whatever the sitter has staged
      // elsewhere on the page in the meantime.
      const timer = window.setInterval(() => {
        if (!popup || popup.closed) {
          window.clearInterval(timer);
          void refreshCalendarStatus();
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

  // Bookings live here (not in BookingsSection) so BookingsSection and CalendarSection read the
  // ONE shared array and a status change made from either refreshes both. The list endpoint runs
  // Google-deletion reconciliation server-side (reconcileIfStale), so whichever section mounts
  // first inherits freshness — with Calendar as the landing view, that's right after login.
  const loadBookings = useCallback(async (): Promise<AdminBooking[]> => {
    try {
      const { bookings: list } = await adminApi.bookings.list(slug, token);
      return list;
    } catch (e) {
      handle(e);
      throw e;
    }
  }, [slug, token, handle]);

  const { data: bookings, reload: reloadBookings } = useAsync(loadBookings);

  // Initial settings load: setState only inside the promise callback (react-hooks rule).
  useEffect(() => {
    let active = true;
    loadSettings()
      .then((s) => {
        if (!active) return;
        applyLoaded(s);
        if (!wizardAutoOpened.current && s.services.every((sv) => !sv.enabled)) {
          wizardAutoOpened.current = true;
          setWizardOpen(true);
        }
      })
      .catch((e) => active && handle(e));
    return () => {
      active = false;
    };
  }, [loadSettings, handle, applyLoaded]);

  if (!settings) return <p className="pb-wrap">Loading…</p>;

  const panels: Record<SectionKey, ReactNode> = {
    calendar: (
      <CalendarSection
        session={session}
        settings={settings}
        bookings={bookings}
        reloadBookings={reloadBookings}
        onOpenBooking={(id) => {
          setFocusBookingId(id);
          // Switch synchronously (same event handler, so React batches this with the
          // setFocusBookingId above into one render/commit) instead of waiting on the
          // 'hashchange' listener below, which fires as a separate later task. React
          // applies DOM mutations (here, clearing the Bookings panel's `hidden` attribute)
          // during the commit phase, strictly before any effect for that commit runs — so
          // by the time BookingsSection's focus effect (which also fired from this same
          // commit, since focusId changed) reads the DOM, the panel is already unhidden and
          // scrollIntoView works. Setting the hash too preserves back/forward + refresh
          // deep-linking; the hashchange handler will re-set the same 'bookings' value,
          // which React no-ops as an unchanged state update.
          setActiveSection('bookings');
          window.location.hash = 'bookings';
        }}
        handleError={handle}
        clearError={() => setError('')}
      />
    ),
    bookings: (
      <BookingsSection
        session={session}
        bookings={bookings}
        reloadBookings={reloadBookings}
        handleError={handle}
        clearError={() => setError('')}
        focusId={focusBookingId}
        onFocusConsumed={() => setFocusBookingId(null)}
      />
    ),
    earnings: (
      <EarningsSection session={session} handleError={handle} clearError={() => setError('')} />
    ),
    business: <BusinessSection settings={settings} setSettings={setSettings} />,
    pets: (
      <PetsSection
        settings={settings}
        addPetType={addPetType}
        renamePetType={renamePetType}
        removePetType={removePetType}
      />
    ),
    services: (
      <ServicesSection
        settings={settings}
        setSettings={setSettings}
        addService={addService}
        removeService={removeService}
        openWizard={() => setWizardOpen(true)}
      />
    ),
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
      // settings.petTypes is the full registry (slug + label) — pet creation is gated by
      // registry membership, not per-service acceptance, so the whole registry (not just the
      // slugs) is what ClientsSection needs to render correct option labels.
      <ClientsSection
        customers={customers ?? []}
        petTypes={settings.petTypes}
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
    help: <HelpSection />,
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
        <div className="pb-savebar" role="status" ref={setDashSavebarEl}>
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

      {wizardOpen && (
        <SetupWizard
          settings={settings}
          slug={slug}
          token={token}
          onClose={() => setWizardOpen(false)}
          onApplied={async () => {
            await refresh();
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<AnySession | null>(null);
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
            role?: 'admin' | 'owner';
            slug?: string;
            displayName?: string;
            email?: string;
          };
          if (body.role === 'owner' && body.email) {
            setSession({ token, role: 'owner', email: body.email });
          } else if (body.slug) {
            setSession({
              token,
              role: 'admin',
              slug: body.slug,
              displayName: body.displayName ?? body.slug,
            });
          } else {
            storeToken(null);
          }
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
  if (session.role === 'owner') return <OwnerConsole session={session} onSignOut={signOut} />;
  return <Dashboard session={session} onSignOut={signOut} />;
}
