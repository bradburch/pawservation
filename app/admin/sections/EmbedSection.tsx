import { useEffect, useRef, useState } from 'react';
import { IconCode } from '../../shared-ui/icons';
import { adminFetch, type Session } from '../shared.js';

function Snippets({ session }: { session: Session }) {
  const [snippets, setSnippets] = useState<{
    script: string;
    iframe: string;
  } | null>(null);

  useEffect(() => {
    adminFetch<{ script: string; iframe: string }>(
      session.token,
      `/api/${session.slug}/admin/snippet`,
    )
      .then((s) => setSnippets(s))
      .catch(() => setSnippets(null));
  }, [session]);

  if (!snippets) return <p>Loading…</p>;
  return (
    <div>
      <p>
        <strong>Squarespace</strong> (Code Block, Core plan or higher) and most sites — paste this
        auto-resizing snippet:
      </p>
      <textarea readOnly rows={3} value={snippets.script} onFocus={(e) => e.target.select()} />
      <p>
        <strong>Wix</strong> ("Embed a site") and script-stripping hosts — use the plain iframe
        (fixed height, scrolls internally):
      </p>
      <textarea readOnly rows={3} value={snippets.iframe} onFocus={(e) => e.target.select()} />
    </div>
  );
}

/**
 * A live, same-origin preview of the sitter's own embed widget — the exact `/embed/:slug` page a
 * customer sees, rendered with the tenant's SAVED branding, rates, and rules. `reloadKey` is bumped
 * after a save to remount the frame with fresh config. The widget always fetches config
 * server-side, so this never exposes anything the customer can't already see.
 *
 * Sizing: the production loader auto-resizes off the widget's `pawbook:resize` postMessage because
 * it frames the widget CROSS-origin and can't read its document. This preview is SAME-origin, so it
 * measures `contentDocument` directly and watches the inner <body> — more reliable than the
 * widget's single ping, which fires before its date inputs and fonts settle.
 */
function WidgetPreview({ slug, reloadKey }: { slug: string; reloadKey: number }) {
  const [height, setHeight] = useState(520);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // `reloadKey` remounts the iframe (fresh config after a save). Sizing off the iframe `load` event
  // is fragile — cache and StrictMode double-mount can drop it — so we briefly poll instead. Each
  // tick re-observes whenever the iframe's <body> changes (the about:blank → /embed navigation
  // swaps it); a ResizeObserver then tracks later changes (e.g. switching widget tabs). We measure
  // the BODY's height, not documentElement.scrollHeight — the latter is floored at the iframe's own
  // height, so it reads a stale 520 while the widget is still loading.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    let observed: HTMLElement | null = null;
    let ticks = 0;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.max(320, body.scrollHeight));
    };
    const tick = () => {
      const body = frame.contentDocument?.body; // same-origin first-party path — always readable.
      if (body && body !== observed) {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(body);
        observed = body;
      }
      measure();
      if (++ticks > 25) window.clearInterval(timer); // ~5s; the ResizeObserver carries on after.
    };
    const timer = window.setInterval(tick, 200);
    tick();
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, [reloadKey]);

  return (
    <div className="pb-preview">
      <div className="pb-preview-bar" aria-hidden="true">
        <span className="pb-dot" />
        <span className="pb-dot" />
        <span className="pb-dot" />
        <span className="pb-preview-url">/embed/{slug}</span>
      </div>
      <iframe
        key={reloadKey}
        ref={frameRef}
        className="pb-preview-frame"
        title="Live preview of your booking widget"
        src={`/embed/${encodeURIComponent(slug)}`}
        style={{ height }}
      />
    </div>
  );
}

export function EmbedSection({ session, previewKey }: { session: Session; previewKey: number }) {
  return (
    <>
      <h2>
        <IconCode size={18} /> Add to your website
      </h2>
      <p className="pb-applies">
        A live preview of your widget — exactly what customers see, with your saved branding. Save
        settings to refresh it.
      </p>
      <WidgetPreview slug={session.slug} reloadKey={previewKey} />
      <Snippets session={session} />
    </>
  );
}
