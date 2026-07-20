import { useCallback, useState } from 'react';
import { isAuthExpired } from '../shared-ui/api.js';
import { useAsync } from '../shared-ui/useAsync';
import { adminFetch, type OwnerSession } from './shared.js';
import { Hint } from './Hint';

/**
 * Platform-owner console: who may join Pawbook. Deliberately non-technical copy — the owner
 * allowlists an email out-of-band, then the sitter starts signup themselves from the sign-in
 * page. Claimed rows can't be removed here (tenant deletion is out of scope).
 */

type Entry = {
  email: string;
  addedAt: string;
  claimedAt: string | null;
  tenantSlug: string | null;
  orphaned: boolean;
};

export function OwnerConsole({
  session,
  onSignOut,
}: {
  session: OwnerSession;
  onSignOut: () => void;
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (isAuthExpired(e)) onSignOut();
      else setError(e instanceof Error ? e.message : 'Try again.');
    },
    [onSignOut],
  );

  // Fetch-only (no setState of its own) so the mount-time load can run through useAsync's
  // effect, which is the codebase's established way to satisfy react-hooks/set-state-in-effect
  // (see the doc comment on useAsync, and App.tsx's loadCustomers for the same shape).
  const loadEntries = useCallback(async (): Promise<Entry[]> => {
    try {
      const { entries: list } = await adminFetch<{ entries: Entry[] }>(
        session.token,
        '/api/owner/allowlist',
      );
      return list;
    } catch (e) {
      handle(e);
      throw e;
    }
  }, [session.token, handle]);

  const { data: entries, reload } = useAsync(loadEntries);

  const add = async () => {
    if (busy || !email.trim()) return;
    setError('');
    setBusy(true);
    try {
      await adminFetch(session.token, '/api/owner/allowlist', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setEmail('');
      reload();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setError('');
    try {
      await adminFetch(session.token, `/api/owner/allowlist/${encodeURIComponent(target)}`, {
        method: 'DELETE',
      });
      reload();
    } catch (e) {
      handle(e);
    }
  };

  return (
    <div className="pb-wrap">
      <header className="pb-topbar">
        <div className="pb-topbar-row">
          <h1>Who can join Pawbook</h1>
          <button className="pb-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="pb-card pb-owner-console">
        <p>Add a sitter&rsquo;s email — then tell them to go to the sign-in page and enter it.</p>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
        </label>
        <button onClick={add} disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        {error && <p className="pb-error">{error}</p>}

        {entries === null ? (
          <p>Loading…</p>
        ) : entries.length === 0 ? (
          <p>No one yet — add the first email above.</p>
        ) : (
          // The container (not the page body) scrolls horizontally if a long email or the
          // "Joined — business deleted" chip still won't fit at narrow widths — see .pb-table-wrap.
          <div className="pb-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>
                    Status{' '}
                    <Hint label="Status">
                      &ldquo;Waiting to join&rdquo; means they haven&rsquo;t signed up yet and can
                      still be removed. Joined means they&rsquo;ve set up their business; if it was
                      later deleted you&rsquo;ll see that flagged here.
                    </Hint>
                  </th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.email}>
                    <td>{e.email}</td>
                    <td>
                      {e.orphaned ? (
                        <span className="pb-chip pb-chip-warn">Joined — business deleted</span>
                      ) : e.claimedAt ? (
                        `Joined → ${e.tenantSlug ?? ''}`
                      ) : (
                        'Waiting to join'
                      )}
                    </td>
                    <td>
                      {!e.claimedAt && <button onClick={() => void remove(e.email)}>Remove</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
