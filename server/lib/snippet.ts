/** Per-tenant embed snippets (PRD FR24): loader-script variant + plain-iframe fallback. */

export type EmbedSnippets = {
  /** Preferred: auto-resizing loader script (Squarespace Code Block, generic HTML embeds). */
  script: string;
  /** Fallback for script-stripping hosts and Wix "Embed a site" — fixed height, internal scroll. */
  iframe: string;
};

/** Escape for an HTML double-quoted attribute value. */
function htmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function embedSnippets(origin: string, slug: string): EmbedSnippets {
  return {
    // The loader URL-encodes the slug itself when building the iframe src, so the data attribute
    // carries the RAW slug (HTML-escaped only) — encoding here too would double-encode it.
    script: `<script src="${origin}/embed.js" data-pawservation-tenant="${htmlAttr(slug)}" data-height="520"></script>`,
    // The iframe variant builds the URL directly, so it URL-encodes the slug here.
    iframe: `<iframe src="${origin}/embed/${encodeURIComponent(slug)}" title="Booking widget" style="width:100%;height:640px;border:0;"></iframe>`,
  };
}
