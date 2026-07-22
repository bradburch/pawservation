import { useEffect, useMemo, useState } from 'react';
import '../admin/admin.css';

/**
 * Create-password page for emailed signup links (/setup?t=...). The token payload is decoded
 * WITHOUT verification, purely to pick the sitter/owner variant and display the email — the
 * server (POST /api/signup/complete) is the only verifier. On success the admin token goes
 * into localStorage (the dashboard's key) and we hand off to /admin: a sitter lands on the
 * dashboard, where the onboarding wizard auto-opens on zero enabled services; an owner lands
 * on the owner console.
 */

const TOKEN_KEY = 'pawservation-admin-token'; // must match app/admin/App.tsx

/** Mirrors the server-side floor in POST /api/signup/complete (client-side is UX only). */
const MIN_PASSWORD_LENGTH = 8;

type LinkPayload = { email: string; kind: 'sitter' | 'owner'; exp: number };

function decodePayload(token: string | null): LinkPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const b64 = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(b64)) as Partial<LinkPayload>;
    if (typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.kind !== 'sitter' && parsed.kind !== 'owner') return null;
    return parsed as LinkPayload;
  } catch {
    return null;
  }
}

function ExpiredNotice() {
  return (
    <div className="pb-wrap pb-login">
      <h1>This link isn&rsquo;t valid anymore</h1>
      <p>
        This link has expired or was already used — enter your email on the{' '}
        <a href="/admin">sign-in page</a> to get a fresh one.
      </p>
    </div>
  );
}

export default function App() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('t'), []);
  const payload = useMemo(() => decodePayload(token), [token]);
  const isReset = useMemo(
    () => new URLSearchParams(window.location.search).get('reset') === '1',
    [],
  );

  useEffect(() => {
    document.title = isReset ? 'Reset your password' : 'Set up your account';
  }, [isReset]);
  // Captured once at mount (not read live during render, which React's purity rule forbids) —
  // the server re-verifies expiry on submit regardless, so this is UX-only staleness.
  const [now] = useState(() => Date.now());
  const [businessName, setBusinessName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!token || !payload || payload.exp < now) return <ExpiredNotice />;

  const sitter = payload.kind === 'sitter';

  const submit = async () => {
    if (busy) return;
    if (!isReset && sitter && !businessName.trim()) {
      setError('Enter your business name.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const res = await fetch(isReset ? '/api/password-reset/complete' : '/api/signup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          password,
          ...(!isReset && sitter ? { businessName: businessName.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        setError(body.error ?? 'Something went wrong — try again.');
        return;
      }
      try {
        localStorage.setItem(TOKEN_KEY, body.token);
      } catch {
        /* storage denied — /admin will ask them to sign in with their new password */
      }
      window.location.href = '/admin';
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-wrap pb-login">
      <h1>
        {isReset
          ? 'Reset your password'
          : sitter
            ? 'Set up your business'
            : 'Set up your owner account'}
      </h1>
      <p>
        {isReset ? 'Resetting the password for' : 'Setting up'} <strong>{payload.email}</strong>
      </p>
      {!isReset && sitter && (
        <label>
          Business name
          <input
            value={businessName}
            autoComplete="organization"
            onChange={(e) => setBusinessName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
      )}
      <label>
        Password
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <label>
        Confirm password
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <button onClick={submit} disabled={busy}>
        {busy
          ? isReset
            ? 'Resetting…'
            : 'Setting up…'
          : isReset
            ? 'Reset password'
            : 'Finish setup'}
      </button>
      {error && <p className="pb-error">{error}</p>}
    </div>
  );
}
