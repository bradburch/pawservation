import { useCallback, useState } from 'react';
import {
  isAuthExpired,
  owner,
  type AnalyticsPayload,
  type SitterRosterResponse,
  type SitterRow,
  type SitterWindow,
} from '../shared-ui/api.js';
import { useAsync } from '../shared-ui/useAsync';
import { adminFetch, type OwnerSession } from './shared.js';
import { Hint } from './Hint';
import { EarningsView } from './sections/EarningsSection.js';
import { IconChartBar, IconUsers } from '../shared-ui/icons';

/**
 * Platform-owner console: who may join Pawservation. Deliberately non-technical copy — the owner
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

type AddResult = {
  entry: { email: string; claimedAt: string | null };
  emailSent: boolean;
  prototypeLink?: string;
};

const WINDOW_OPTIONS: { key: SitterWindow; label: string }[] = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All time' },
];

type SortKey = 'name' | 'clients' | 'bookings' | 'earned';

/** Numeric columns default to descending (biggest first); name defaults to A→Z. */
function defaultDir(key: SortKey): 'asc' | 'desc' {
  return key === 'name' ? 'asc' : 'desc';
}

function sortSitters(rows: SitterRow[], sort: { key: SortKey; dir: 'asc' | 'desc' }): SitterRow[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === 'name') return a.displayName.localeCompare(b.displayName) * mul;
    return (a[sort.key] - b[sort.key]) * mul;
  });
}

function sortIndicator(sort: { key: SortKey; dir: 'asc' | 'desc' }, key: SortKey): string {
  if (sort.key !== key) return '';
  return sort.dir === 'asc' ? ' ▲' : ' ▼';
}

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
  const [note, setNote] = useState<AddResult | null>(null);

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
    setNote(null);
    setBusy(true);
    try {
      const result = await adminFetch<AddResult>(session.token, '/api/owner/allowlist', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setEmail('');
      setNote(result);
      reload();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setError('');
    setNote(null);
    try {
      await adminFetch(session.token, `/api/owner/allowlist/${encodeURIComponent(target)}`, {
        method: 'DELETE',
      });
      reload();
    } catch (e) {
      handle(e);
    }
  };

  // ── Dashboard tab: platform-wide sitter roster + drill-down. Kept separate from the
  // allowlist state/handlers above (which stay untouched) — its own error state so an
  // allowlist error doesn't bleed into the Dashboard tab or vice versa, same
  // isAuthExpired(e) → onSignOut() convention as `handle` above.
  const [tab, setTab] = useState<'dashboard' | 'allowlist'>('dashboard');
  const [win, setWin] = useState<SitterWindow>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'earned',
    dir: 'desc',
  });
  const [selected, setSelected] = useState<{ tenantId: string; displayName: string } | null>(null);
  const [dashError, setDashError] = useState('');

  const handleDash = useCallback(
    (e: unknown) => {
      if (isAuthExpired(e)) onSignOut();
      else setDashError(e instanceof Error ? e.message : 'Try again.');
    },
    [onSignOut],
  );

  const loadRoster = useCallback(async (): Promise<SitterRosterResponse> => {
    setDashError('');
    try {
      return await owner.sitters(session.token, win);
    } catch (e) {
      handleDash(e);
      throw e;
    }
  }, [session.token, win, handleDash]);

  const { data: roster } = useAsync(loadRoster);

  const loadDetail = useCallback(async (): Promise<AnalyticsPayload | null> => {
    if (!selected) return null;
    setDashError('');
    try {
      return await owner.sitterDetail(session.token, selected.tenantId, win);
    } catch (e) {
      handleDash(e);
      throw e;
    }
  }, [session.token, selected, win, handleDash]);

  const { data: detail } = useAsync(loadDetail);

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: defaultDir(key) },
    );
  };

  return (
    <div className="pb-wrap">
      <header className="pb-topbar">
        <div className="pb-topbar-row">
          <h1>Pawservation</h1>
          <button className="pb-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <nav className="pb-topnav" aria-label="Sections">
          <div className="pb-navtabs">
            <button
              type="button"
              className={`pb-navtab${tab === 'dashboard' ? ' pb-navtab-active' : ''}`}
              aria-current={tab === 'dashboard' ? 'page' : undefined}
              onClick={() => setTab('dashboard')}
            >
              <IconChartBar size={16} /> Dashboard
            </button>
            <button
              type="button"
              className={`pb-navtab${tab === 'allowlist' ? ' pb-navtab-active' : ''}`}
              aria-current={tab === 'allowlist' ? 'page' : undefined}
              onClick={() => setTab('allowlist')}
            >
              <IconUsers size={16} /> Who can join
            </button>
          </div>
        </nav>
      </header>

      {tab === 'dashboard' && (
        <div className="pb-card">
          {selected ? (
            <>
              <button type="button" className="pb-linklike" onClick={() => setSelected(null)}>
                ← Back to roster
              </button>
              <h2>{selected.displayName}</h2>
              {dashError && <p className="pb-error">{dashError}</p>}
              {detail === null ? <p>Loading…</p> : <EarningsView data={detail} />}
            </>
          ) : (
            <>
              <h2>
                <IconChartBar size={18} /> Dashboard
                <Hint label="Dashboard">
                  Platform-wide totals across every sitter on Pawservation. Pick a window to narrow
                  bookings/earned to that period — clients always shown all-time. Click a sitter to
                  see their full earnings breakdown, read-only.
                </Hint>
              </h2>

              <div className="pb-navtabs">
                {WINDOW_OPTIONS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`pb-navtab${win === key ? ' pb-navtab-active' : ''}`}
                    aria-current={win === key ? 'page' : undefined}
                    onClick={() => setWin(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {dashError && <p className="pb-error">{dashError}</p>}

              {roster === null ? (
                <p>Loading…</p>
              ) : (
                <>
                  <div className="pb-tiles">
                    <div className="pb-tile">
                      <strong>{roster.totals.sitters}</strong>
                      <span>Sitters</span>
                    </div>
                    <div className="pb-tile">
                      <strong>{roster.totals.clients}</strong>
                      <span>Clients</span>
                    </div>
                    <div className="pb-tile">
                      <strong>{roster.totals.bookings}</strong>
                      <span>Bookings</span>
                    </div>
                    <div className="pb-tile">
                      <strong>${roster.totals.earned}</strong>
                      <span>Earned</span>
                    </div>
                  </div>

                  {roster.sitters.length === 0 ? (
                    <p>No sitters yet.</p>
                  ) : (
                    <div className="pb-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>
                              <button
                                type="button"
                                className="pb-linklike"
                                onClick={() => toggleSort('name')}
                              >
                                Sitter{sortIndicator(sort, 'name')}
                              </button>
                            </th>
                            <th>
                              <button
                                type="button"
                                className="pb-linklike"
                                onClick={() => toggleSort('clients')}
                              >
                                Clients{sortIndicator(sort, 'clients')}
                              </button>
                            </th>
                            <th>
                              <button
                                type="button"
                                className="pb-linklike"
                                onClick={() => toggleSort('bookings')}
                              >
                                Bookings{sortIndicator(sort, 'bookings')}
                              </button>
                            </th>
                            <th>
                              <button
                                type="button"
                                className="pb-linklike"
                                onClick={() => toggleSort('earned')}
                              >
                                Earned{sortIndicator(sort, 'earned')}
                              </button>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortSitters(roster.sitters, sort).map((s) => (
                            <tr
                              key={s.tenantId}
                              onClick={() =>
                                setSelected({ tenantId: s.tenantId, displayName: s.displayName })
                              }
                              style={{ cursor: 'pointer' }}
                            >
                              <td>{s.displayName}</td>
                              <td>{s.clients}</td>
                              <td>{s.bookings}</td>
                              <td>${s.earned}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'allowlist' && (
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
          {note &&
            (note.entry.claimedAt ? (
              <p>{note.entry.email} already has an account.</p>
            ) : note.prototypeLink ? (
              <p className="pb-ok">
                {/* Dev only: the server returns prototypeLink when no email provider is configured
                  (mirrors the login page's setup-link affordance). */}
                Invite ready — <a href={note.prototypeLink}>open the setup link (dev)</a>.
              </p>
            ) : note.emailSent ? (
              <p className="pb-ok">Invite sent to {note.entry.email}.</p>
            ) : (
              <p className="pb-error">
                Added {note.entry.email}, but the invite email couldn&rsquo;t be sent — re-add to
                retry.
              </p>
            ))}

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
                        still be removed. Joined means they&rsquo;ve set up their business; if it
                        was later deleted you&rsquo;ll see that flagged here.
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
                        {!e.claimedAt && (
                          <button onClick={() => void remove(e.email)}>Remove</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
