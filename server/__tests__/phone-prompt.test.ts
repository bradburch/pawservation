import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsPhone } from '../../app/embed/phone-gate.js';
import { liveSource } from './helpers/live-source';

/**
 * THE WIDGET'S ONE-TIME PHONE PROMPT, pinned at its source — there is no DOM harness for the embed
 * bundle (see pay-embed.test.ts). The decision itself is a pure function and is tested as one; the
 * wiring is pinned the way every other UI promise in this suite is, on `liveSource` so a pinned
 * string surviving in a comment cannot pass.
 */

const EMBED = join(import.meta.dirname, '..', '..', 'app', 'embed');
const read = (file: string) => readFileSync(join(EMBED, file), 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const PROMPT = flat(liveSource(read('PhonePrompt.tsx')));
const PROMPT_TEXT = flat(liveSource(read('PhonePrompt.tsx'), { keepLiterals: true }));
const APP = flat(liveSource(read('App.tsx')));
const BOOK_TEXT = flat(liveSource(read('BookTab.tsx'), { keepLiterals: true }));
const API_TEXT = flat(
  liveSource(readFileSync(join(EMBED, '..', 'shared-ui', 'api.ts'), 'utf8'), {
    keepLiterals: true,
  }),
);

describe('needsPhone', () => {
  it('asks only a signed-in client whose /me says there is no phone on file', () => {
    expect(needsPhone({ phone: null })).toBe(true);
  });

  it('never asks a client who has a phone', () => {
    expect(needsPhone({ phone: '(555) 555-0142' })).toBe(false);
  });

  it('does not ask when it cannot know — /me not loaded, failed, or from a worker without the field', () => {
    expect(needsPhone(null)).toBe(false);
    expect(needsPhone({})).toBe(false);
    expect(needsPhone({ phone: undefined })).toBe(false);
  });
});

describe('the prompt cannot be skipped', () => {
  it('has exactly one button, and it saves', () => {
    expect(PROMPT.match(/<button/g)).toHaveLength(1);
    expect(PROMPT).toContain('onClick={() => void save()}');
  });

  it('offers no way out but a phone', () => {
    for (const exit of ['onSkip', 'onClose', 'onDismiss', 'onCancel', 'Later'])
      expect(PROMPT_TEXT).not.toContain(exit);
  });

  it('asks for a telephone number in a tel field and says why, once', () => {
    expect(PROMPT_TEXT).toContain('type="tel"');
    expect(PROMPT_TEXT).toContain('autoComplete="tel"');
    expect(PROMPT_TEXT).toContain('can reach you');
    expect(PROMPT_TEXT).toContain('only be asked once');
  });

  it('saves through PATCH /:slug/me', () => {
    expect(PROMPT).toContain('api.updateMyPhone(');
    expect(API_TEXT).toMatch(/updateMyPhone: .*`\/api\/\$\{slug\}\/me`, \{ method: 'PATCH'/);
  });
});

describe('the widget puts the prompt in front of booking', () => {
  it('decides from /me, from a booking refused for want of a phone, and never while editing', () => {
    expect(APP).toContain('const askingForPhone = !editing && (askPhone ?? needsPhone(me));');
  });

  it('shows the prompt in front of the booking form, which stays mounted (hidden) so its entries survive', () => {
    const asking = APP.indexOf('{askingForPhone && (');
    const prompt = APP.indexOf('<PhonePrompt', asking);
    const form = APP.indexOf('<BookTab', asking);
    expect(asking).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(asking);
    expect(form).toBeGreaterThan(prompt);
    expect(APP).toContain('<div hidden={askingForPhone}>');
    expect(APP).not.toContain('askingForPhone ? (');
  });

  it('turns a phone_required refusal from the booking POST into the prompt', () => {
    expect(BOOK_TEXT).toContain("e.code === 'phone_required'");
    expect(BOOK_TEXT.indexOf('onPhoneRequired();')).toBeGreaterThan(
      BOOK_TEXT.indexOf("e.code === 'phone_required'"),
    );
  });
});
