import { useState } from 'react';
import { api, setToken } from '../shared-ui/api';
import { errorMsg, slug } from './shared';

type IdentifyState =
  | { step: 'email' }
  | { step: 'code'; codeId: string; prototypeCode?: string; email: string };

export function Identify({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<IdentifyState>({ step: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitEmail = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.identify(slug, email);
      setState({
        step: 'code',
        codeId: res.codeId,
        prototypeCode: res.prototypeCode,
        email,
      });
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (state.step !== 'code') return;
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.verify(slug, state.codeId, code);
      setToken(slug, res.token);
      onDone();
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (state.step === 'email') {
    return (
      <div className="bp-identify">
        <label className="bp-field">
          Your email
          <input
            type="email"
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitEmail()}
          />
        </label>
        <button onClick={submitEmail} disabled={busy}>
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
        {error && <p className="bp-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bp-identify">
      <p className="bp-proto-code">
        {state.prototypeCode ? (
          <>
            Your code: <strong>{state.prototypeCode}</strong>
            <br />
            <small>(dev mode: this would be emailed to {state.email})</small>
          </>
        ) : (
          <>
            We emailed a 6-digit code to <strong>{state.email}</strong>.
          </>
        )}
      </p>
      <input
        className="bp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        placeholder="······"
        aria-label="6-digit code"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
      />
      <button onClick={submitCode} disabled={busy}>
        {busy ? 'Verifying…' : 'Verify'}
      </button>
      {error && <p className="bp-error">{error}</p>}
    </div>
  );
}
