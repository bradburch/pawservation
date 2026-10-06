import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * MIGRATION 0019 APPLIED TO A PRE-MIGRATION DATABASE — 0018's pattern: the pre-0019 fixture is
 * schema.sql with the marked block cut out, so the two definitions cannot drift.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'migrations', '0019_booking_series.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8');
const START = '-- >>> 0019 booking series';
const END = '-- <<< 0019 booking series';

function cut(sql: string): string {
  let out = sql;
  for (;;) {
    const from = out.indexOf(START);
    if (from === -1) return out;
    const to = out.indexOf(END, from);
    if (to === -1) throw new Error('schema.sql has an unclosed 0019 marker');
    out = out.slice(0, from) + out.slice(to + END.length + 1);
  }
}
const db = (sql: string) => { const raw = new DatabaseSync(':memory:'); raw.exec(sql); return raw; };
const tables = (raw: DatabaseSync) =>
  (raw.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name LIKE '%Series%' AND sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[])
    .map((r) => ({ name: r.name, sql: r.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /g, '') }));
const bookingCols = (raw: DatabaseSync) =>
  (raw.prepare('PRAGMA table_info(BookingRequests)').all() as { name: string }[]).map((c) => c.name).sort();

describe('migration 0019 — the file', () => {
  it('contains no transaction statement', () => {
    expect(MIGRATION).not.toMatch(/\b(BEGIN|COMMIT|SAVEPOINT)\b/i);
  });
  it('adds exactly one BookingRequests column, with no DEFAULT', () => {
    expect(MIGRATION.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(MIGRATION).toMatch(/ALTER TABLE BookingRequests ADD COLUMN SeriesId TEXT;/);
  });
});

describe('migration 0019 — applied to the live shape', () => {
  it('produces exactly what schema.sql builds', () => {
    const migrated = db(cut(SCHEMA));
    migrated.exec(MIGRATION);
    const fresh = db(SCHEMA);
    expect(tables(migrated)).toEqual(tables(fresh));
    expect(bookingCols(migrated)).toEqual(bookingCols(fresh));
  });
  it('leaves every existing booking a single booking (SeriesId NULL)', () => {
    const raw = db(cut(SCHEMA));
    raw.exec(`INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t','t','T');
      INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, PetCount, Status, CreatedAt)
      VALUES ('b','t','walk','2026-11-03',1,'confirmed','2026-10-01');`);
    raw.exec(MIGRATION);
    expect(raw.prepare('SELECT SeriesId FROM BookingRequests').get()).toEqual({ SeriesId: null });
  });
  it('refuses a second row for one series on one date, and allows many single bookings on it', () => {
    const raw = db(SCHEMA);
    raw.exec(`INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t','t','T');`);
    const ins = (id: string, series: string | null) => raw.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, PetCount, Status, SeriesId, CreatedAt)
       VALUES (?, 't', 'walk', '2026-11-03', 1, 'pending', ?, '2026-10-01')`).run(id, series);
    ins('a', null); ins('b', null); ins('c', 's1');
    expect(() => ins('d', 's1')).toThrow(/UNIQUE/);
  });
  it('refuses an unknown skip reason and a weekday mask outside 1–127', () => {
    const raw = db(SCHEMA);
    expect(() => raw.exec(`INSERT INTO BookingSeriesSkips VALUES ('s','t','2026-11-03','sick','x')`)).toThrow(/CHECK/);
    expect(() => raw.exec(`INSERT INTO BookingSeries (Id, TenantId, EndUserId, ServiceType, Weekdays, StartDate, Status, CreatedBy, CreatedAt, UpdatedAt)
      VALUES ('s','t','u','walk',128,'2026-11-03','pending','client','x','x')`)).toThrow(/CHECK/);
  });
});
