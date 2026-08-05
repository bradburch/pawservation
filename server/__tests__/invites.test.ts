import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertInvitedCustomer } from '../db/repo';
import { createTestEnv } from './helpers';

function identify(env: Env, email: string) {
  return app.request(
    '/api/sunny-paws/identify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
    env,
  );
}

describe('invite-only identify', () => {
  it('rejects an un-invited email with 403', async () => {
    const { env } = createTestEnv();
    const res = await identify(env, 'stranger@example.com');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { prototypeCode?: string };
    expect(body.prototypeCode).toBeUndefined();
  });

  it('accepts a seeded active customer', async () => {
    const { env } = createTestEnv();
    const res = await identify(env, 'jess@example.com');
    expect(res.status).toBe(200);
  });

  it('accepts an invited customer and promotes them to active on verify', async () => {
    const { env, raw } = createTestEnv();
    const cust = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      'tnt_sunnypaws',
      'invited@example.com',
      'Inv',
    );
    const idRes = await identify(env, 'invited@example.com');
    expect(idRes.status).toBe(200);
    const { codeId, prototypeCode } = (await idRes.json()) as {
      codeId: string;
      prototypeCode: string;
    };

    const vRes = await app.request(
      '/api/sunny-paws/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId, code: prototypeCode }),
      },
      env,
    );
    expect(vRes.status).toBe(200);
    const row = raw.prepare(`SELECT Status FROM EndUsers WHERE Id=?`).get(cust.Id) as {
      Status: string;
    };
    expect(row.Status).toBe('active');
  });
});
