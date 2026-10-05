import { useState } from 'react';
import { api, getToken, isAuthExpired } from '../shared-ui/api';
import { errorMsg, slug } from './shared';

/**
 * The one-time phone prompt: shown to a signed-in client with no phone on file, in place of the
 * booking form, until they give one. There is deliberately no skip and no close — the owner's
 * ruling is that such a client cannot book until the sitter can reach them, and the server refuses
 * their booking (`phone_required`) whatever this screen does. "Once" is a property of the data, not
 * of a flag here: after it is saved, `/me` reports the phone and this is never shown again.
 */
export function PhonePrompt({
  displayName,
  onSaved,
  onAuthExpired,
}: {
  displayName: string;
  onSaved: () => void;
  onAuthExpired: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const token = getToken(slug);
    if (!token) {
      onAuthExpired();
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.updateMyPhone(slug, token, phone);
      onSaved();
    } catch (e) {
      if (isAuthExpired(e)) {
        onAuthExpired();
        return;
      }
      // The server's own sentence: "Enter a phone number." or the digit rule.
      setError(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bp-identify">
      <p className="bp-signin-lede">
        Before you book, please add a phone number so {displayName} can reach you. You&apos;ll only
        be asked once.
      </p>
      <label className="bp-field">
        Your phone number
        <input
          type="tel"
          value={phone}
          placeholder="(555) 555-0100"
          autoComplete="tel"
          maxLength={40}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
      </label>
      <button onClick={() => void save()} disabled={busy || phone.trim() === ''}>
        {busy ? 'Saving…' : 'Save and continue'}
      </button>
      {error && (
        <p className="bp-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
