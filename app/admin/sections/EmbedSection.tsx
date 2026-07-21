import { useEffect, useState } from 'react';
import { IconCode } from '../../shared-ui/icons';
import { adminFetch, type Session } from '../shared.js';
import { Hint } from '../Hint';

function CopyableSnippet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 5000);
    } catch {
      /* clipboard denied — the textarea still selects on focus for manual copy */
    }
  };
  return (
    <div>
      <textarea readOnly rows={3} value={value} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={() => void copy()}>
        {copied ? 'Copied!' : 'Copy the code'}
      </button>
    </div>
  );
}

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
        You don&apos;t need to understand the code below — just copy it and paste it into your
        website builder. Ask whoever manages your website to help if you get stuck.
      </p>
      <p>
        <strong>Squarespace and most other website builders:</strong>{' '}
        <Hint label="the embed codes">
          Both codes show the same booking page. Try the first; if your website builder refuses it,
          the second works everywhere.
        </Hint>
      </p>
      <ol>
        <li>Click &ldquo;Copy the code&rdquo; below.</li>
        <li>In Squarespace, edit the page where you want bookings to appear.</li>
        <li>
          Click a &ldquo;+&rdquo; to add a content block and choose <strong>Code</strong> (on some
          Squarespace plans the Code block is not available — use the Wix/iframe code below with an
          <strong> Embed</strong> block instead).
        </li>
        <li>Paste the code and save the page. Your booking form appears right there.</li>
      </ol>
      <CopyableSnippet value={snippets.script} />
      <p>
        <strong>Wix</strong> (choose &ldquo;Embed a site&rdquo;) <strong>and other builders</strong>{' '}
        where the code above doesn&apos;t work — use this one instead:
      </p>
      <CopyableSnippet value={snippets.iframe} />
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
 * loader which auto-resizes off the widget's `pawservation:resize` postMessage (it must resize
 * cross-origin, lacking access to contentDocument).
 */
function WidgetPreview({ slug, reloadKey }: { slug: string; reloadKey: number }) {
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
        <Hint label="Your website">
          Your booking page, ready to drop into your own site. Copy the code, paste it into your
          website builder, and clients book without leaving your site.
        </Hint>
      </h2>
      <p className="pb-applies">
        A live preview of your widget — exactly what customers see, with your saved branding. Save
        settings to refresh it.
      </p>
      {everActive && (
        <>
          <WidgetPreview slug={session.slug} reloadKey={previewKey} />
          <Snippets session={session} />
        </>
      )}
    </>
  );
}
