import { useEffect, useState } from 'react';

export interface AsyncResult<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `fn` in an effect and exposes its settled result. Re-runs whenever `fn`'s identity
 * changes — memoize it with `useCallback` listing its real dependencies, the same discipline
 * `useEffect` deps already require — or whenever `reload()` is called. `reload()` is
 * fire-and-forget: it schedules a re-run and returns immediately; observe completion through
 * `loading`/`data`, not a promise.
 *
 * On failure, `error` is set but the last successful `data` is retained (stale-while-error),
 * so a failed reload doesn't blank out data the user was already looking at. Callers that
 * want blank-on-error can gate on `error` themselves.
 *
 * Replaces the repeated `let active = true` + cleanup-flag dance: a stale resolution (from a
 * superseded `fn` or a reload that's since been superseded again) is detected the same way —
 * by comparing the fn/reload the result belongs to against the current one — and is dropped
 * instead of applied. setState is only ever called from inside the `.then`/`.catch` callbacks
 * below, never synchronously in the effect body, so this satisfies
 * react-hooks/set-state-in-effect without a suppression.
 */
export function useAsync<T>(fn: () => Promise<T>): AsyncResult<T> {
  const [reloadCount, setReloadCount] = useState(0);
  const [settled, setSettled] = useState<{
    forFn: (() => Promise<T>) | null;
    forReload: number;
    data: T | null;
    error: unknown;
  }>({ forFn: null, forReload: -1, data: null, error: null });

  useEffect(() => {
    let active = true;
    fn()
      .then((data) => {
        if (active) setSettled({ forFn: fn, forReload: reloadCount, data, error: null });
      })
      .catch((error: unknown) => {
        // Keep prev.data: a failed refetch shows the error alongside the last-known data
        // rather than wiping it (stale-while-error, see the doc comment).
        if (active) {
          setSettled((prev) => ({ forFn: fn, forReload: reloadCount, data: prev.data, error }));
        }
      });
    return () => {
      active = false;
    };
  }, [fn, reloadCount]);

  const loading = settled.forFn !== fn || settled.forReload !== reloadCount;

  return {
    data: settled.data,
    error: settled.error,
    loading,
    reload: () => setReloadCount((c) => c + 1),
  };
}
