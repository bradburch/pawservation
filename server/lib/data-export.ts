import {
  listAllEndUserPetsByTenant,
  listBookingsForTenant,
  listChargesForTenant,
  listCustomers,
  listPaymentsForTenant,
  listPetNamesForTenantBookings,
  listServices,
} from '../db/repo';
import { serializeCsvRows, type CsvValue } from './csv';

/**
 * A SITTER MAY TAKE HER BOOK WITH HER. She can already import a client list; until this there was
 * no way back out, which is a reason not to put a client list in at all. Four files, each one the
 * plain contents of a table she already sees on screen: deceased pets, cancelled bookings and
 * declined requests are all present, with their status in a column, because it is her record of
 * what happened.
 *
 * It is her RECORDS, not a backup of her account, and the panel says so in those words. What is
 * deliberately absent: her time off (`listBookingsForTenant` excludes `ServiceType = 'blocked'`,
 * and a blocked day is her own note to herself rather than a thing that happened with a client),
 * her services, rates, cancellation tiers and intake question DEFINITIONS (settings, which an
 * import would have to be able to re-apply to mean anything), and the individual `BookingCharges`
 * rows, which arrive as one `Charges total` column. Widening any of that is a decision about what
 * the four files are; quietly widening the COPY that describes them is how a promise gets made
 * that the code does not keep, which is the defect review found here.
 *
 * Every read here goes through `server/db/repo.ts` and is therefore tenant-scoped in its own SQL;
 * this module never sees the D1 binding except to hand it on.
 */
export const EXPORT_DATASETS = ['clients', 'pets', 'bookings', 'payments'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export function isExportDataset(value: string): value is ExportDataset {
  return (EXPORT_DATASETS as readonly string[]).includes(value);
}

/** Two lists that must not be confused when a name is missing: the sitter recognises a client by
 *  name, and by email only when there is no name. */
const clientLabel = (name: string | null, email: string | null): string => name || email || '';

const joinNames = (names: string[]): string => names.join('; ');

/**
 * Intake answers rendered as the sitter reads them on the booking row: the question's own LABEL,
 * not the UUID it is keyed by. A question deleted since the booking was made no longer has a label,
 * so its id is printed rather than dropped — the customer answered something, and losing the answer
 * because the question is gone would be the export editing her record.
 */
function formatAnswers(
  answers: Record<string, string>,
  labels: Map<string, string> | undefined,
): string {
  return Object.entries(answers)
    .map(([id, value]) => `${labels?.get(id) ?? id}: ${value}`)
    .join('; ');
}

/** 'YYYY-MM-DD to YYYY-MM-DD', or the single date when a booking has no end. */
const dateRange = (start: string | null, end: string | null): string =>
  start ? (end ? `${start} to ${end}` : start) : '';

async function clientsCsv(db: D1Database, tenantId: string): Promise<CsvValue[][]> {
  const [customers, petLinks] = await Promise.all([
    listCustomers(db, tenantId),
    listAllEndUserPetsByTenant(db, tenantId),
  ]);
  // listAllEndUserPetsByTenant returns ONE ROW PER OWNER LINK, so a co-owned pet lands in both
  // owners' lists — the same grouping the admin clients list does, and the truthful one here too.
  const petsByOwner = new Map<string, string[]>();
  for (const pet of petLinks) {
    const names = petsByOwner.get(pet.EndUserId) ?? [];
    names.push(pet.Name);
    petsByOwner.set(pet.EndUserId, names);
  }
  return [
    ['Name', 'Email', 'Phone', 'Venmo username', 'Status', 'Pets', 'Added', 'Invited'],
    ...customers.map((u) => [
      u.Name,
      u.Email,
      u.Phone,
      u.VenmoUsername,
      u.Status,
      joinNames(petsByOwner.get(u.Id) ?? []),
      u.CreatedAt,
      u.InvitedAt,
    ]),
  ];
}

async function petsCsv(db: D1Database, tenantId: string): Promise<CsvValue[][]> {
  const [customers, petLinks] = await Promise.all([
    listCustomers(db, tenantId),
    listAllEndUserPetsByTenant(db, tenantId),
  ]);
  const clientsById = new Map(customers.map((u) => [u.Id, u]));
  // One row per PET, with its owners collapsed onto it — the inverse grouping of clientsCsv over
  // the same link rows. A link whose owner is not a client the sitter can see (the reserved demo
  // identity, which listCustomers filters out) is skipped, so a pet only that identity owns never
  // appears: the same rule loadPaymentMatchInputs applies to where money may be filed.
  const byPet = new Map<
    string,
    { pet: (typeof petLinks)[number]; names: string[]; emails: string[] }
  >();
  for (const pet of petLinks) {
    const owner = clientsById.get(pet.EndUserId);
    if (!owner) continue;
    const entry = byPet.get(pet.Id) ?? { pet, names: [], emails: [] };
    entry.names.push(clientLabel(owner.Name, owner.Email));
    entry.emails.push(owner.Email);
    byPet.set(pet.Id, entry);
  }
  return [
    ['Pet name', 'Type', 'Owners', 'Owner emails', 'Care notes', 'Deceased', 'Added'],
    ...[...byPet.values()].map(({ pet, names, emails }) => [
      pet.Name,
      pet.PetType,
      joinNames(names),
      joinNames(emails),
      pet.Notes,
      pet.DeceasedAt,
      pet.CreatedAt,
    ]),
  ];
}

async function bookingsCsv(db: D1Database, tenantId: string): Promise<CsvValue[][]> {
  const [bookings, charges, petNames, services] = await Promise.all([
    listBookingsForTenant(db, tenantId),
    listChargesForTenant(db, tenantId),
    listPetNamesForTenantBookings(db, tenantId),
    listServices(db, tenantId),
  ]);
  const chargesTotalByBooking = new Map<string, number>();
  for (const charge of charges)
    chargesTotalByBooking.set(
      charge.BookingRequestId,
      (chargesTotalByBooking.get(charge.BookingRequestId) ?? 0) + charge.Amount,
    );
  const petsByBooking = new Map<string, string[]>();
  for (const row of petNames) {
    const names = petsByBooking.get(row.BookingRequestId) ?? [];
    names.push(row.Name);
    petsByBooking.set(row.BookingRequestId, names);
  }
  // Question ids are unique only within one service's Questions JSON, so the label map is keyed
  // per service exactly as SavedAnswers is.
  const labelsByService = new Map<string, Map<string, string>>(
    services.map((svc) => [svc.ServiceType, new Map(svc.Questions.map((q) => [q.id, q.label]))]),
  );
  return [
    [
      'Booking ID',
      'Client',
      'Client email',
      'Service',
      'Status',
      'Start date',
      'End date',
      'Arrival time',
      'Departure time',
      'Option',
      'Pets',
      'Pet count',
      'Estimated cost',
      'Charges total',
      'Cancellation fee',
      'Paid',
      'Answers',
      'Calendar event',
      'Requested at',
    ],
    ...bookings.map((b) => [
      b.Id,
      clientLabel(b.Name, b.Email),
      b.Email,
      b.ServiceType,
      b.Status,
      b.StartDate,
      b.EndDate,
      b.StartTime,
      b.DepartureTime,
      b.OptionKey,
      joinNames(petsByBooking.get(b.Id) ?? []),
      b.PetCount,
      b.EstCost,
      chargesTotalByBooking.get(b.Id) ?? 0,
      b.CancellationFee,
      b.PaidTotal ?? 0,
      formatAnswers(b.Answers, labelsByService.get(b.ServiceType)),
      // Only ever set on a 'external' row — a foreign Google event this worker materialized so it
      // blocks capacity. It carries no client and no price, so without its title the row would be
      // an unexplained blank line in her own record.
      b.ExternalSummary,
      b.CreatedAt,
    ]),
  ];
}

async function paymentsCsv(db: D1Database, tenantId: string): Promise<CsvValue[][]> {
  const payments = await listPaymentsForTenant(db, tenantId);
  return [
    [
      'Paid date',
      'Amount',
      'Method',
      'Note',
      'Settles',
      'Client',
      'Client email',
      'Booking ID',
      'Booking service',
      'Booking dates',
      'Household',
      'Recorded at',
    ],
    ...payments.map((p) => [
      p.PaidDate,
      p.Amount,
      p.Method,
      p.Note,
      // Exactly one of the two, guaranteed by the CHECK on Payments (0011) rather than by this
      // ternary — which is why the column can name a side rather than hedging.
      p.BookingRequestId ? 'booking' : 'household',
      clientLabel(p.CustomerName, p.CustomerEmail),
      p.CustomerEmail,
      p.BookingRequestId,
      p.BookingServiceType,
      dateRange(p.BookingStartDate, p.BookingEndDate),
      // The pet the household is filed under, falling back to the RAW account id when that pet has
      // since been deleted (`unattachedPaymentAccountIds`). Without the fallback such a row exports
      // with a blank client, a blank booking AND a blank household — money with no attribution at
      // all — and the id is the only thread left that leads back to what it was filed against.
      p.AccountPetName ?? p.AccountId,
      p.CreatedAt,
    ]),
  ];
}

/** One dataset as a CSV string. Tenant scoping is in the SQL of every read this dispatches to. */
export async function buildExportCsv(
  db: D1Database,
  tenantId: string,
  dataset: ExportDataset,
): Promise<string> {
  const rows =
    dataset === 'clients'
      ? await clientsCsv(db, tenantId)
      : dataset === 'pets'
        ? await petsCsv(db, tenantId)
        : dataset === 'bookings'
          ? await bookingsCsv(db, tenantId)
          : await paymentsCsv(db, tenantId);
  return serializeCsvRows(rows);
}
