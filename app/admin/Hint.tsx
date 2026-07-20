import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Toggletip: a small `?` button that previews a short explainer bubble on hover/keyboard focus
 * and pins it open on click/tap (spec: 2026-07-19-help-and-explainers-design). The button and
 * popover are two sibling elements — never nested interactives. Touch taps arrive as `click`,
 * so tap = pin with no pointer-type sniffing. Copy is children (plain JSX text, ≤2 sentences)
 * so every hint is greppable and reviewable in place.
 */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  // 'preview' is transient (hover/focus, closes on mouseleave/blur); 'pinned' (click) survives
  // mouseleave and closes only on a second activation, Escape, or an outside click.
  const [state, setState] = useState<'closed' | 'preview' | 'pinned'>('closed');
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  // Escape returns focus to the button; that programmatic focus must not re-open the preview.
  const suppressFocus = useRef(false);
  const open = state !== 'closed';

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setState('closed');
      if (document.activeElement !== btnRef.current) {
        suppressFocus.current = true;
        btnRef.current?.focus();
      }
    };
    // Outside click closes only a *pinned* hint (a preview already closes itself on leave/blur).
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setState('closed');
    };
    document.addEventListener('keydown', onKeyDown);
    if (state === 'pinned') document.addEventListener('click', onDocClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onDocClick);
    };
  }, [open, state]);

  // Clamp the popover against the right viewport edge so it never causes horizontal scroll,
  // even for a hint button near the edge at 360px width. Re-runs on window resize while open
  // (e.g. a device rotation or a shrunk browser window) so a pinned hint doesn't keep a stale
  // offset computed at the old viewport size.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    const clamp = () => {
      el.style.left = '0px';
      const overflow = el.getBoundingClientRect().right - document.documentElement.clientWidth + 16;
      if (overflow > 0) el.style.left = `${-overflow}px`;
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [open]);

  return (
    <span className="pb-hintwrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="pb-hint-btn"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onClick={() => setState((s) => (s === 'pinned' ? 'closed' : 'pinned'))}
        onMouseEnter={() => setState((s) => (s === 'closed' ? 'preview' : s))}
        onMouseLeave={() => setState((s) => (s === 'preview' ? 'closed' : s))}
        onFocus={() => {
          if (suppressFocus.current) {
            suppressFocus.current = false;
            return;
          }
          setState((s) => (s === 'closed' ? 'preview' : s));
        }}
        onBlur={() => setState((s) => (s === 'preview' ? 'closed' : s))}
      >
        ?
      </button>
      {open && (
        <span role="note" id={id} className="pb-hint-pop" ref={popRef}>
          {children}
        </span>
      )}
    </span>
  );
}
