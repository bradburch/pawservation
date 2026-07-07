import { useEffect, useState } from 'react';
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
 * Displays at a fixed height (640px / 70vh) with internal scrolling — simpler than the production
 * loader which auto-resizes off the widget's `pawbook:resize` postMessage (it must resize
 * cross-origin, lacking access to contentDocument).
 */
function WidgetPreview({
  slug,
  reloadKey,
  _active,
}: {
  slug: string;
  reloadKey: number;
  _active: boolean;
}) {
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
        className="pb-preview-frame"
        title="Live preview of your booking widget"
        src={`/embed/${encodeURIComponent(slug)}`}
        style={{ height: '640px', maxHeight: '70vh' }}
      />
    </div>
  );
}

export function EmbedSection({
  session,
  previewKey,
  active,
}: {
  session: Session;
  previewKey: number;
  active: boolean;
}) {
  // This section stays mounted even when its tab isn't active, so the preview iframe and
  // snippet fetch don't restart on every tab switch — but they also shouldn't load the moment
  // the dashboard opens for a sitter who never visits Embed. Load them once the tab is first
  // opened, then leave them mounted from then on.
  const [everActive, setEverActive] = useState(active);
  if (active && !everActive) setEverActive(true);

  return (
    <>
      <h2>
        <IconCode size={18} /> Add to your website
      </h2>
      <p className="pb-applies">
        A live preview of your widget — exactly what customers see, with your saved branding. Save
        settings to refresh it.
      </p>
      {everActive && (
        <>
          <WidgetPreview slug={session.slug} reloadKey={previewKey} _active={active} />
          <Snippets session={session} />
        </>
      )}
    </>
  );
}
