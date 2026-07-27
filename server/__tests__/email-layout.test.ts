import { describe, it, expect } from 'vitest';
import { emailShell, emailButton } from '../lib/email';

describe('emailShell', () => {
  it('renders the accent bar, brand line, content, and styled container', () => {
    const html = emailShell('<p>hi</p>');
    expect(html).toContain('max-width:560px');
    expect(html).toContain('background:#2e6440'); // accent bar
    expect(html).toContain('🐾 Pawservation'); // brand line
    expect(html).toContain('<p>hi</p>');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('http');
  });

  it('omits footer border when footer is not provided', () => {
    const html = emailShell('<p>hi</p>');
    expect(html).not.toContain('border-top');
  });

  it('escapes footer HTML entities', () => {
    const html = emailShell('<p>x</p>', 'Sent by Pawservation on behalf of <Evil> & Co');
    expect(html).toContain('&lt;Evil&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<Evil>');
  });
});

describe('emailButton', () => {
  it('escapes URL and label', () => {
    const html = emailButton('https://x.test/a?t=1', 'Go <now>');
    expect(html).toContain('href="https://x.test/a?t=1"');
    expect(html).toContain('Go &lt;now&gt;');
    expect(html).not.toContain('<now>');
  });
});
