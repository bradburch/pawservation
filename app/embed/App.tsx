import { useCallback, useEffect, useState } from 'react';
import {
  api,
  getToken,
  isAuthExpired,
  setToken,
  type Pet,
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

  // Report content height to the parent loader so the iframe auto-resizes (story 3.1).
  useEffect(() => {
    const report = () =>
      window.parent.postMessage(
        // No secrets ever cross postMessage; the loader filters by origin + source.
        {
          type: 'pawbook:resize',
          height: document.documentElement.scrollHeight,
        },
        parentOrigin,
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
  // the booking view renders with a dead calendar that silently ignores taps. `me` resets to
  // null itself once `authed` flips false and `loadMe` re-resolves — the sign-in screen this
  // reveals doesn't read `me` anyway, so there's nothing to observe in between.
  const onAuthExpired = useCallback(() => {
    setToken(slug, null);
    setAuthed(false);
  }, []);

  const loadMe = useCallback(async (): Promise<{ name: string | null; pets: Pet[] } | null> => {
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
      return { name: null, pets: [] };
    }
  }, [authed, onAuthExpired]);

  const { data: me } = useAsync(loadMe);

  if (error) return <p className="bp-error">{error}</p>;
  if (!config) return <p>Loading…</p>;

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
          Enter the email your sitter has on file and we&apos;ll send you a sign-in code.
        </p>
        <Identify onDone={() => setAuthed(true)} />
        {contact}
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
      {contact}
    </div>
  );
}
