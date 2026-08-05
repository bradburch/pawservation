import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { deleteService, deleteTenantCompletely } from '../db/repo';
import { questionShape } from '../../src/shared/index.js';
import app from '../index';
import { createTestEnv, demoToken, endUserToken, TENANT_A, TENANT_B } from './helpers';

const SLUG_A = 'sunny-paws';
const SLUG_B = 'happy-tails';
const SLUG_C = 'paws-and-relax';
const TENANT_C = 'tnt_pawsandrelax';
const JESS = 'jess@example.com';

/** Sunny Paws' boarding form for these tests: one required text, one required yes/no. */
const BOARDING_QUESTIONS = [
  { id: 'feeding', label: 'Feeding routine (times and amounts)', type: 'text', required: true },
  { id: 'vaccines', label: 'Are vaccinations up to date?', type: 'yesno', required: true },
];

function setQuestions(
  raw: DatabaseSync,
  tenantId: string,
  serviceType: string,
  questions: unknown[],
) {
  raw
    .prepare('UPDATE TenantServices SET Questions = ? WHERE TenantId = ? AND ServiceType = ?')
    .run(JSON.stringify(questions), tenantId, serviceType);
}

function savedRows(raw: DatabaseSync, tenantId?: string) {
  return (
    tenantId
      ? raw
          .prepare('SELECT * FROM SavedAnswers WHERE TenantId = ? ORDER BY QuestionId')
          .all(tenantId)
      : raw.prepare('SELECT * FROM SavedAnswers ORDER BY QuestionId').all()
  ) as {
    TenantId: string;
    EndUserId: string;
    ServiceType: string;
    QuestionId: string;
    Shape: string;
    Value: string;
  }[];
}

function book(env: Env, slug: string, token: string, body: Record<string, unknown>) {
  return app.request(
    `/api/${slug}/bookings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function me(env: Env, slug: string, token: string) {
  const res = await app.request(
    `/api/${slug}/me`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    name: string | null;
    pets: { id: string }[];
    savedAnswers: Record<string, Record<string, string>>;
  };
}

/** One boarding booking at Sunny Paws with Bella; dates parked past every seeded fixture. */
function boardingBody(answers: Record<string, string>, month = '04') {
  return {
    type: 'boarding',
    startDate: `2029-${month}-10`,
    endDate: `2029-${month}-12`,
    petIds: ['pet_sp_bella'],
    answers,
  };
}

describe('questionShape', () => {
  it('is the same question through cosmetic label edits', () => {
    const base = {
      id: 'vet',
      label: "Vet's phone number?",
      type: 'text' as const,
      required: false,
    };
    expect(questionShape({ ...base, label: 'Vets phone number' })).toBe(questionShape(base));
    expect(questionShape({ ...base, label: '  VET’S   PHONE NUMBER ' })).toBe(questionShape(base));
  });

  it('changes when the question is reworded or retyped', () => {
    const base = { id: 'q', label: 'Feeding routine', type: 'text' as const, required: true };
    expect(questionShape({ ...base, label: 'Emergency vet phone number' })).not.toBe(
      questionShape(base),
    );
    expect(questionShape({ ...base, type: 'number' })).not.toBe(questionShape(base));
  });

  it('ignores constraints — those bound the answer, they do not change the question', () => {
    const num = { id: 'w', label: 'Pet weight', type: 'number' as const, required: true, min: 1 };
    expect(questionShape({ ...num, min: 20, max: 90 })).toBe(questionShape(num));
    const sel = {
      id: 'e',
      label: 'How will we get in?',
      type: 'select' as const,
      required: true,
      options: ['Lockbox'],
    };
    expect(questionShape({ ...sel, options: ['Lockbox', 'Hidden key'] })).toBe(questionShape(sel));
    expect(questionShape({ ...sel, required: false })).toBe(questionShape(sel));
  });
});

describe('saved intake answers', () => {
  it('saves what was submitted and pre-fills the next booking with it', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);

    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({});

    const res = await book(
      env,
      SLUG_A,
      token,
      boardingBody({ feeding: '7am and 6pm, one cup', vaccines: 'yes' }),
    );
    expect(res.status).toBe(201);

    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({
      boarding: { feeding: '7am and 6pm, one cup', vaccines: 'yes' },
    });
    // Scoped to the service that asked — a different service's form is untouched.
    expect(savedRows(raw, TENANT_A).every((r) => r.ServiceType === 'boarding')).toBe(true);
  });

  it('overwrites the saved value with whatever the next booking submits', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);

    expect(
      (await book(env, SLUG_A, token, boardingBody({ feeding: 'one cup', vaccines: 'yes' })))
        .status,
    ).toBe(201);
    expect(
      (await book(env, SLUG_A, token, boardingBody({ feeding: 'two cups', vaccines: 'no' }, '05')))
        .status,
    ).toBe(201);

    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({
      boarding: { feeding: 'two cups', vaccines: 'no' },
    });
    // Upsert, not append: still one row per question.
    expect(savedRows(raw, TENANT_A)).toHaveLength(2);
  });

  it('forgets an answer the customer cleared, rather than re-offering it', async () => {
    const { env, raw } = createTestEnv();
    // Both optional, so a blank submission is a legal booking.
    setQuestions(raw, TENANT_A, 'boarding', [
      { id: 'feeding', label: 'Feeding routine', type: 'text', required: false },
      { id: 'vaccines', label: 'Are vaccinations up to date?', type: 'yesno', required: false },
    ]);
    const token = await endUserToken(env, SLUG_A, JESS);

    await book(env, SLUG_A, token, boardingBody({ feeding: 'one cup', vaccines: 'yes' }));
    await book(env, SLUG_A, token, boardingBody({ feeding: '', vaccines: 'yes' }, '05'));

    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({ boarding: { vaccines: 'yes' } });
    expect(savedRows(raw, TENANT_A)).toHaveLength(1);
  });

  it('never saves an answer to a question the service did not ask', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);

    // The widget can still be holding a previously-selected service's answers in state.
    await book(
      env,
      SLUG_A,
      token,
      boardingBody({ feeding: 'one cup', vaccines: 'yes', leash: 'by the door' }),
    );

    expect(
      savedRows(raw, TENANT_A)
        .map((r) => r.QuestionId)
        .sort(),
    ).toEqual(['feeding', 'vaccines']);
  });

  it('re-validates a pre-filled answer at the POST exactly like a typed one', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);
    await book(env, SLUG_A, token, boardingBody({ feeding: 'one cup', vaccines: 'yes' }));

    // The sitter turns the yes/no into a number question with a range. The customer's browser
    // could still be holding the old 'yes' — sending it must be refused, not accepted because it
    // was once saved.
    setQuestions(raw, TENANT_A, 'boarding', [
      BOARDING_QUESTIONS[0],
      { id: 'vaccines', label: 'How many vaccinations?', type: 'number', required: true, min: 1 },
    ]);
    const res = await book(
      env,
      SLUG_A,
      token,
      boardingBody({ feeding: 'one cup', vaccines: 'yes' }, '05'),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_answers' });
  });

  it('does not pre-fill an answer whose question has since been reworded or retyped', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);
    await book(env, SLUG_A, token, boardingBody({ feeding: '7am and 6pm', vaccines: 'yes' }));

    // Same ids, same types, different questions entirely: 'feeding' now asks for a phone number,
    // and 'vaccines' becomes a text field. The stored answers would both still VALIDATE — the
    // shape guard is the only thing standing between the customer and a pre-filled lie.
    setQuestions(raw, TENANT_A, 'boarding', [
      { id: 'feeding', label: 'Emergency vet phone number', type: 'text', required: true },
      { id: 'vaccines', label: 'Are vaccinations up to date?', type: 'text', required: true },
    ]);

    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({});
  });

  it('does not pre-fill an answer the question no longer accepts', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', [
      {
        id: 'entry',
        label: 'How will we get in?',
        type: 'select',
        required: true,
        options: ['Lockbox', 'Hidden key'],
      },
    ]);
    const token = await endUserToken(env, SLUG_A, JESS);
    await book(env, SLUG_A, token, boardingBody({ entry: 'Lockbox' }));
    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({ boarding: { entry: 'Lockbox' } });

    // The shape is unchanged (options are constraints, not the question) — validity is the gate
    // that catches this one.
    setQuestions(raw, TENANT_A, 'boarding', [
      {
        id: 'entry',
        label: 'How will we get in?',
        type: 'select',
        required: true,
        options: ['Garage code', 'Hand off in person'],
      },
    ]);
    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({});

    // ...and an option merely ADDED keeps the saved answer, which is why options are not shaped.
    setQuestions(raw, TENANT_A, 'boarding', [
      {
        id: 'entry',
        label: 'How will we get in?',
        type: 'select',
        required: true,
        options: ['Lockbox', 'Hidden key', 'Garage code'],
      },
    ]);
    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({ boarding: { entry: 'Lockbox' } });
  });

  it('drops an answer to a question the service no longer asks at all', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);
    await book(env, SLUG_A, token, boardingBody({ feeding: 'one cup', vaccines: 'yes' }));

    setQuestions(raw, TENANT_A, 'boarding', [BOARDING_QUESTIONS[1]]);
    expect((await me(env, SLUG_A, token)).savedAnswers).toEqual({ boarding: { vaccines: 'yes' } });
  });

  it('never leaks across tenants or between customers', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    setQuestions(raw, TENANT_B, 'boarding', BOARDING_QUESTIONS);
    const tokenA = await endUserToken(env, SLUG_A, JESS);
    await book(env, SLUG_A, tokenA, boardingBody({ feeding: 'one cup', vaccines: 'yes' }));

    // The SAME email is a different customer at Happy Tails, with its own boarding service whose
    // questions carry the very same ids and shapes.
    const tokenB = await endUserToken(env, SLUG_B, JESS);
    expect((await me(env, SLUG_B, tokenB)).savedAnswers).toEqual({});

    // A second Sunny Paws customer with rows of their own must not appear in Jess's pre-fills.
    raw
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status)
              VALUES ('eu_sp_other', ?, 'sam@example.com', 'Sam', 'active')`,
      )
      .run(TENANT_A);
    raw
      .prepare(
        `INSERT INTO SavedAnswers (TenantId, EndUserId, ServiceType, QuestionId, Shape, Value)
              VALUES (?, 'eu_sp_other', 'boarding', 'feeding', ?, 'SAM ONLY')`,
      )
      .run(TENANT_A, questionShape(BOARDING_QUESTIONS[0] as never));

    const mine = await me(env, SLUG_A, tokenA);
    expect(mine.savedAnswers).toEqual({ boarding: { feeding: 'one cup', vaccines: 'yes' } });
    expect(JSON.stringify(mine)).not.toContain('SAM ONLY');
  });

  it('persists nothing for the reserved demo identity', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_C, 'boarding', BOARDING_QUESTIONS);
    const token = await demoToken(env, SLUG_C);
    const demoPetId = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = ? AND u.Email = 'demo@pawservation.com'`,
        )
        .get(TENANT_C) as { Id: string }
    ).Id;

    const res = await book(env, SLUG_C, token, {
      type: 'boarding',
      startDate: '2029-04-10',
      endDate: '2029-04-12',
      petIds: [demoPetId],
      answers: { feeding: 'one cup', vaccines: 'yes' },
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { demo?: boolean }).toMatchObject({ demo: true });

    expect(savedRows(raw)).toHaveLength(0);
    expect((await me(env, SLUG_C, token)).savedAnswers).toEqual({});
  });

  it('is scrubbed when its service is deleted, and when the tenant is deleted', async () => {
    const { env, raw } = createTestEnv();
    setQuestions(raw, TENANT_A, 'boarding', BOARDING_QUESTIONS);
    const token = await endUserToken(env, SLUG_A, JESS);
    await book(env, SLUG_A, token, boardingBody({ feeding: 'one cup', vaccines: 'yes' }));
    expect(savedRows(raw, TENANT_A)).toHaveLength(2);

    // deleteService refuses nothing here — it is the repo call the admin route makes once it has
    // established the service has no bookings; the point is that the rate/answer scrub rides with
    // it, so a re-created 'boarding' cannot inherit these.
    raw.prepare('DELETE FROM BookingRequestPets').run();
    raw.prepare('DELETE FROM BookingRequests WHERE TenantId = ?').run(TENANT_A);
    await deleteService(env.PAWSERVATION_DB, TENANT_A, 'boarding');
    expect(savedRows(raw, TENANT_A)).toHaveLength(0);

    // And the whole-tenant delete list: rows for the OTHER tenant's customer must go with it.
    raw
      .prepare(
        `INSERT INTO SavedAnswers (TenantId, EndUserId, ServiceType, QuestionId, Shape, Value)
              VALUES (?, 'eu_ht_jess', 'boarding', 'feeding', 'text|feeding routine', 'x')`,
      )
      .run(TENANT_B);
    expect(await deleteTenantCompletely(env.PAWSERVATION_DB, TENANT_B)).toBe(true);
    expect(savedRows(raw, TENANT_B)).toHaveLength(0);
  });
});
