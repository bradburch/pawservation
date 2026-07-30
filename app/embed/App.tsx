import { useCallback, useEffect, useState } from 'react';
import {
  api,
  getToken,
  isAuthExpired,
  setToken,
  type Booking,
  type Me,
  type TenantConfig,
} from '../shared-ui/api';
import { useAsync } from '../shared-ui/useAsync';
import './widget.css';
import { Identify } from './Identify';
import { BookTab } from './BookTab';
import { MineTab } from './MineTab';
import { slug, parentOrigin } from './shared';

export default function App() {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [authed, setAuthed] = useState(() => !!getToken(slug));
  const [error, setError] = useState('');
  const [showMine, setShowMine] = useState(false);
  /**
   * The booking being CHANGED, or null. Held here rather than inside MineTab because an edit
   * borrows the whole booking form — the same service rules, the same silent quote, the same
   * calendar — and re-implementing that inside a card would be the second implementation this
   * project exists to avoid. Moving between "my bookings" and the form is a NAVIGATION, which
   * already changes the widget's height; nothing here changes height on an in-place interaction.
   */
  const [editing, setEditing] = useState<Booking | null>(null);

  // Report content height to the parent loader so the iframe auto-resizes (story 3.1).
  useEffect(() => {
    const report = () => {
      // No secrets ever cross postMessage; the loader filters by origin + source. Both type
      // families are posted: a host page may serve an HTTP-cached pre-rebrand loader that only
      // understands `pawbook:resize`; the current loader reacts to `pawservation:resize` only,
      // so no loader vintage handles both.
      for (const type of ['pawservation:resize', 'pawbook:resize']) {
        window.parent.postMessage(
          { type, height: document.documentElement.scrollHeight },
          parentOrigin,
        );
      }
    };
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
  // the booking view renders with a dead calendar that silently ignores taps. `me` resets to
  // null itself once `authed` flips false and `loadMe` re-resolves — the sign-in screen this
  // reveals doesn't read `me` anyway, so there's nothing to observe in between.
  const onAuthExpired = useCallback(() => {
    setToken(slug, null);
    setAuthed(false);
  }, []);

  const loadMe = useCallback(async (): Promise<Me | null> => {
    if (!authed) return null;
    const token = getToken(slug);
    if (!token) return null;
    try {
      return await api.me(slug, token);
    } catch (e) {
      if (isAuthExpired(e)) {
        onAuthExpired();
        return null;
      }
      return { name: null, pets: [], savedAnswers: {} };
    }
  }, [authed, onAuthExpired]);

  const { data: me } = useAsync(loadMe);

  if (error) return <p className="bp-error">{error}</p>;
  if (!config) return <p>Loading…</p>;

  // The sitter's account is disabled platform-side — the server's non-GET guard is the real
  // enforcement (routes 403 with account_disabled); this is purely UX so a customer sees a
  // clear reason instead of a booking form that would fail on submit.
  if (config.disabled) {
    return (
      <div className="bp-widget">
        <h1 className="bp-greeting">{config.displayName}</h1>
        <p className="bp-signin-lede">
          This business isn&apos;t currently taking bookings. Please check back later.
        </p>
      </div>
    );
  }

  const contact =
    config.contactEmail || config.contactPhone ? (
      <p className="bp-signin-lede">
        Questions?{' '}
        {config.contactPhone ? (
          <>
            Call <a href={`tel:${config.contactPhone}`}>{config.contactPhone}</a>
          </>
        ) : null}
        {config.contactPhone && config.contactEmail ? ' or ' : null}
        {config.contactEmail ? (
          <>
            email <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>
          </>
        ) : null}
        .
      </p>
    ) : null;

  if (!authed) {
    return (
      <div className="bp-widget">
        <h1 className="bp-greeting">Book with {config.displayName}</h1>
        <p className="bp-signin-lede">
          Welcome! {config.displayName} uses Pawservation to take booking requests online — pick
          your dates, send a request, and your sitter confirms it personally.
        </p>
        <ol className="bp-welcome-steps">
          <li>Enter the email your sitter has on file for you.</li>
          <li>We&apos;ll email you a 6-digit sign-in code — no password to remember.</li>
          <li>Pick your dates and your pets, and send the request.</li>
        </ol>
        <Identify onDone={() => setAuthed(true)} />
        <p className="bp-new-client">
          <strong>New client?</strong> Booking is invite-only — get in touch with{' '}
          {config.displayName} and they&apos;ll add you and your pets.
        </p>
        {contact}
      </div>
    );
  }

  const firstName = (me?.name ?? '').trim().split(/\s+/)[0] || 'there';
  return (
    <div className="bp-widget bp-book-view">
      <div className="bp-topline">
        <button
          className="bp-mine-link"
          onClick={() => {
            setEditing(null);
            setShowMine((s) => !s);
          }}
        >
          {showMine ? '← Book' : 'My bookings'}
        </button>
      </div>
      {showMine ? (
        <>
          <h1 className="bp-greeting">Your bookings</h1>
          <MineTab
            config={config}
            onEdit={(b) => {
              setEditing(b);
              setShowMine(false);
            }}
          />
        </>
      ) : (
        <>
          <h1 className="bp-greeting">
            {editing ? 'Change your booking' : `How can I help, ${firstName}?`}
          </h1>
          <BookTab
            // A fresh mount per edit target: BookTab seeds its dates, pets, arrival time and
            // answers from `editing` in useState initializers, which run once per mount. Without
            // the key, switching from one booking to another (or back to a new request) would
            // keep the previous form's state.
            key={editing?.id ?? 'new'}
            config={config}
            pets={me?.pets ?? null}
            savedAnswers={me?.savedAnswers ?? null}
            editing={editing}
            onEditSaved={() => {
              setEditing(null);
              setShowMine(true);
            }}
            onEditCancel={() => {
              setEditing(null);
              setShowMine(true);
            }}
            onAuthExpired={onAuthExpired}
          />
        </>
      )}
      {contact}
    </div>
  );
}
