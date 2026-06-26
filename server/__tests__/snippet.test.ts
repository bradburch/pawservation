import { describe, expect, it } from 'vitest';
import app from '../index';
import { embedSnippets } from '../lib/snippet';
import { adminToken, createTestEnv, TENANT_A } from './helpers';

describe('embed snippets', () => {
  it('generates both variants with the right origin and slug', () => {
    const { script, iframe } = embedSnippets('https://proto.example.workers.dev', 'happy-tails');
    expect(script).toBe(
      '<script src="https://proto.example.workers.dev/embed.js" data-bradpaws-tenant="happy-tails" data-height="520"></script>',
    );
    expect(iframe).toContain('src="https://proto.example.workers.dev/embed/happy-tails"');
    expect(iframe).toContain('height:640px');
  });

  it('passes the raw slug to the loader (loader URL-encodes) and HTML-escapes attribute specials', () => {
    // Script variant: raw slug in the data attribute — the loader encodeURIComponent's it for the URL,
    // so pre-encoding here would double-encode. HTML-special chars are still escaped for attribute safety.
    const { script } = embedSnippets('https://x.dev', 'weird slug');
    expect(script).toContain('data-bradpaws-tenant="weird slug"');
    const escaped = embedSnippets('https://x.dev', 'a"b&c').script;
    expect(escaped).toContain('data-bradpaws-tenant="a&quot;b&amp;c"');

    // Iframe variant: builds the URL directly, so it URL-encodes.
    const { iframe } = embedSnippets('https://x.dev', 'weird slug');
    expect(iframe).toContain('/embed/weird%20slug');
  });

  it('serves per-tenant snippets through the admin API using the request origin', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      'https://proto.example.workers.dev/api/brad-paws/admin/snippet',
      { headers: { Authorization: `Bearer ${await adminToken(TENANT_A)}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { script: string; iframe: string };
    expect(body.script).toContain('data-bradpaws-tenant="brad-paws"');
    expect(body.script).toContain('https://proto.example.workers.dev/embed.js');
    expect(body.iframe).toContain('https://proto.example.workers.dev/embed/brad-paws');
  });
});
