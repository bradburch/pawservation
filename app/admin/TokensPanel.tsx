import { useEffect, useRef, useState } from 'react';
import { adminApi, ApiError, isAuthExpired, type AdminAccessToken } from '../shared-ui/api.js';
import type { Session } from './shared.js';

const MAX_NAME_LENGTH = 80;

/** A trailing 'Z' or a '+HH:MM'/'-HH:MM' offset — the only two ways a stamp states its zone.
 *  Tested after the normalising below, so any space in front of an offset is already gone. */
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `TenantAccessTokens.CreatedAt`/`LastUsedAt` come off SQLite's `datetime('now')` as
 * "YYYY-MM-DD HH:MM:SS" UTC, no 'T' and no 'Z' — not something every engine parses the same way
 * unlabelled. Label it UTC ourselves before handing it to `Date`, and fall back to the raw string
 * rather than ever rendering "Invalid Date".
 *
 * The test is for a stated ZONE, not for a 'T'. "2026-09-07T12:00:00" carries a separator and no
 * zone at all, and JavaScript reads that one as LOCAL time — so keying on the 'T' would have left
 * exactly that shape unlabelled and shifted by the viewer's offset, which is the reading nobody
 * would notice was wrong.
 */
function formatTimestamp(sqlDatetime: string): string {
  // Only the date/time separator becomes a 'T'. A blanket `.replace(' ', 'T')` is the first space,
  // which is the right one here — but a stamp can carry a SECOND space before its offset
  // ("2026-09-07 12:00:00 +01:00"), and that one has to go away entirely rather than turn into
  // anything, or `Date` reads the whole string as invalid and the sitter sees the raw text.
  const withT = sqlDatetime.replace(/\s+(?=\d{2}:)/, 'T').replace(/\s+(?=[+-]\d{2}:\d{2}$)/, '');
  const d = new Date(ZONED.test(withT) ? withT : `${withT}Z`);
  return Number.isNaN(d.getTime()) ? sqlDatetime : d.toLocaleDateString();
}

/**
 * ACCESS TOKENS (0016): a sitter's own long-lived Bearer credential for the dashboard API, minted
 * and revoked without anyone's cooperation. The plaintext exists in exactly one response ever —
 * `adminApi.tokens.create`'s — so it is held here in component state only, never written to
 * localStorage and never re-fetched, because there is no read path back to it that would work.
 *
 * The failure path is deliberately loud, same posture as ExportPanel: a mint or revoke that
 * quietly does nothing reads as "the button is broken" rather than as a real problem worth
 * retrying.
 */
export function TokensPanel({
  session,
  handleError,
}: {
  session: Session;
  /**
   * The dashboard's own failure path (`App.tsx`'s `handle`). A 401 or 403 from any call here means
   * the password session this panel needs has gone — expired, or revoked under it — and the panel
   * has nothing useful to say about that. Handing it up signs the sitter out, which is the only
   * response that leads anywhere; showing "could not load your tokens" beside a dead session would
   * read as a broken feature.
   */
  handleError: (e: unknown) => void;
}) {
  const [tokens, setTokens] = useState<AdminAccessToken[] | null>(null);
  const [listError, setListError] = useState('');

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  // The plaintext, held ONLY here — see the docblock above.
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const copiedTimeoutRef = useRef<number | null>(null);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState('');

  const load = () =>
    adminApi.tokens
      .list(session.slug, session.token)
      .then(({ tokens: list }) => {
        setTokens(list);
        setListError('');
      })
      .catch((e) => {
        if (isAuthExpired(e)) return handleError(e);
        setListError(e instanceof Error ? e.message : 'Could not load your tokens.');
      });

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Leaving the panel clears the plaintext too, so it never outlives the one screen it was
  // minted for — state alone would already be gone on unmount, but this makes that explicit
  // rather than relying on it. The "Copied!" revert timer is cleared alongside it so it never
  // fires a state update against an unmounted component.
  useEffect(() => {
    return () => {
      setCreated(null);
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
    };
  }, []);

  const trimmedName = name.trim();
  const canCreate = trimmedName.length >= 1 && trimmedName.length <= MAX_NAME_LENGTH && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setCreateError('');
    try {
      const result = await adminApi.tokens.create(session.slug, session.token, trimmedName);
      setCreated({ name: result.name, token: result.token });
      setCopied(false);
      setCopyError('');
      setName('');
      await load();
    } catch (e) {
      if (isAuthExpired(e)) handleError(e);
      else setCreateError(e instanceof Error ? e.message : 'Could not create a token. Try again.');
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setCopyError('');
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 5000);
    } catch {
      setCopyError('Could not copy automatically. Select the token below and copy it yourself.');
    }
  };

  const revoke = async (id: string) => {
    if (revokingId) return;
    setRevokingId(id);
    setRevokeError('');
    try {
      await adminApi.tokens.revoke(session.slug, session.token, id);
      setConfirmingId(null);
      await load();
    } catch (e) {
      if (isAuthExpired(e)) {
        handleError(e);
      } else if (e instanceof ApiError && e.status === 404) {
        // The row is already gone — revoked in another tab, or by the token itself when whatever
        // held it disconnected. The sitter asked for it gone and it is gone, so this is not a
        // failure to report: drop the confirmation and re-read the list, which is the thing that
        // was actually out of date.
        setConfirmingId(null);
        await load();
      } else {
        setRevokeError(e instanceof Error ? e.message : 'Could not revoke that token. Try again.');
      }
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <>
      <h3>Access tokens</h3>
      <p className="pb-hint">
        A token acts as your sign-in for this dashboard&apos;s API, so a script or another tool can
        work as you: it can do everything you can here, including deleting clients and exporting
        your book, and it never expires. It cannot create, list or revoke other tokens; only your
        password can. Revoke it here the moment you suspect it leaked.
      </p>
      {created ? (
        <div>
          <p>
            <strong>{created.name}</strong> is ready.
          </p>
          {/* A live credential in a text field. Password managers offer to save whatever they
              find in one, spellcheckers on some platforms send its contents away to be checked,
              and a browser that remembers it hands it to the next person at this desk — none of
              which the sitter asked for, and all of which outlive the one screen this value is
              supposed to exist on. */}
          <textarea
            readOnly
            rows={2}
            aria-label="New access token"
            value={created.token}
            autoComplete="off"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore
            onFocus={(e) => e.target.select()}
          />
          <div className="pb-row">
            <button type="button" onClick={() => void copy()}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
          {copyError && <p className="pb-error">{copyError}</p>}
          <p>
            <strong>This is the only time you will see it. Copy it now.</strong> It is on your
            clipboard after Copy; paste it where it belongs and clear it.
          </p>
        </div>
      ) : (
        <form
          className="pb-row"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            type="text"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            placeholder="What is this token for? e.g. Booking sync script"
            aria-label="Token name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={!canCreate}>
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </form>
      )}
      {createError && <p className="pb-error">{createError}</p>}
      {tokens === null ? (
        listError ? (
          <p className="pb-error">{listError}</p>
        ) : (
          <p className="pb-hint">Loading your tokens…</p>
        )
      ) : (
        <>
          {tokens.length === 0 ? (
            <p className="pb-hint">You have not created any access tokens yet.</p>
          ) : (
            <ul>
              {tokens.map((t) => (
                <li key={t.id}>
                  <span>
                    <strong>{t.name}</strong>
                    <br />
                    <span className="pb-hint">
                      Created {formatTimestamp(t.createdAt)}
                      {' · '}
                      Last used {t.lastUsedAt ? formatTimestamp(t.lastUsedAt) : 'never'}
                    </span>
                  </span>
                  {confirmingId === t.id ? (
                    <span>
                      <button
                        type="button"
                        disabled={revokingId === t.id}
                        onClick={() => void revoke(t.id)}
                      >
                        {revokingId === t.id ? 'Revoking…' : 'Really revoke?'}
                      </button>{' '}
                      <button
                        type="button"
                        disabled={revokingId === t.id}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(t.id)}
                      aria-label={`Revoke ${t.name}`}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* A failed re-list after a create or revoke leaves the OLD list on screen — loud by
              the same rule as everything else here: a stale list must never look current. */}
          {listError && <p className="pb-error">{listError}</p>}
        </>
      )}
      {revokeError && <p className="pb-error">{revokeError}</p>}
    </>
  );
}
