/** Tiny same-origin API client for the widget + admin pages. */

export { PAYMENT_METHODS } from '../../src/shared/index.js';
import type { ServiceConstraints, ServiceOption, ServiceQuestion } from '../../src/shared/index.js';

// Re-exported as-is: the widget/admin config wire format is field-for-field the shared shape —
// see src/shared/booking/service-rules.ts for the single definition.
export type { ServiceOption, ServiceQuestion };

export type ServiceConfig = ServiceConstraints & {
  type: string;
  label: string;
  icon: string; // widget icon key: bed|home|sun|paw|clipboard
  /** Short sitter-written blurb shown under the service name in the picker; null = show nothing. */
  description: string | null;
  shape: 'range' | 'single';
  rateUnit: 'night' | 'day' | 'visit' | 'walk';
  hasDuration: boolean;
  options: ServiceOption[];
  questions: ServiceQuestion[];
  acceptedPetTypes: string[] | null;
  cancellationTiers: { withinDays: number; percent: number }[] | null;
  /** The sitter's holiday rate, for labelling only; null = no holiday pricing. */
  holidayRate: number | null;
};
export type TenantConfig = {
  slug: string;
  displayName: string;
  accentColor: string;
  timezone: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  petTypes: { slug: string; label: string }[]; // the FULL pet-type registry — serves as the label map; offered types derive per service
  services: ServiceConfig[];
  disabled: boolean;
};

export type Pet = {
  id: string;
  name: string;
  petType: string;
  notes?: string | null;
  /** NULL/absent = alive. Only the admin payload sets it — customer-facing lists omit deceased pets. */
  deceasedAt?: string | null;
};
export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
};

// Hand-mirrors server/lib/availability.ts's AvailabilityResult — keep the two in step.
export type Availability =
  | {
      available: true;
      priced: true;
      estCost: number;
      /** Quantity `estCost` was billed for, with its noun. Absent for single-day services
       *  (flat per-booking charge, no quantity). Label from these, never from
       *  `ServiceConfig.rateUnit` — the number and its noun must share one source. */
      billedUnits?: number;
      unit?: 'night' | 'day';
      /** Wire-compat only; always a night count. Prefer `billedUnits`/`unit`. */
      nights?: number;
      /** How many billed units the SERVER charged at the sitter's holiday rate, and that rate.
       *  Both absent unless a holiday actually applied. Display only — `estCost` already
       *  includes them; the widget must never re-derive a total from these. */
      holidayUnits?: number;
      holidayRate?: number;
    }
  | {
      /** The dates are free but the sitter has never priced this set of pets. The widget shows
       *  her contact details and blocks submit. It must NEVER compute a substitute price — the
       *  client does not do money. */
      available: true;
      priced: false;
      reason: 'unpriced-pet-set';
      groupKey: string;
      mixKey: string;
    }
  | { available: false; reason: string };

export type Booking = {
  id: string;
  type: string;
  startDate: string;
  endDate: string | null;
  petCount: number;
  estCost: number | null;
  /** Extras the sitter added after the fact. `estCost` excludes them by design; what the client
   *  owes is `estCost + chargesTotal`. */
  charges: { label: string; amount: number }[];
  chargesTotal: number;
  cancellationFee: number | null;
  status: string;
  pets: string[];
};

export type Customer = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  venmoUsername: string | null;
  status: 'invited' | 'active';
  invitedAt?: string | null;
  pets: Pet[];
};

/** One stored specific-pets rate (PetGroupPricing row), wire shape from the admin routes. */
export type PetGroupRate = {
  id: string;
  serviceType: string;
  optionKey: string;
  petIds: string[];
  rate: number;
  updatedAt: string;
};

export type ImportResult = {
  importedCustomers: number;
  importedPets: number;
  invitesSent: number;
  invitesFailed: number;
  skippedRows: { row: number; reason: string }[];
};

export type AdminBooking = {
  id: string;
  customerEmail: string | null;
  customerName: string | null;
  type: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  optionKey: string | null;
  petCount: number;
  /** True for a materialized Google Calendar event: read-only, blocks capacity, no customer. */
  external: boolean;
  /** The Google event's title, for calendar display. Null unless external. */
  externalSummary: string | null;
  /** Intake answers keyed by question id; {} when the customer answered nothing. */
  answers: Record<string, string>;
  estCost: number | null;
  paidTotal: number;
  charges: BookingCharge[];
  /** SUM(charges). Total due is `estCost + chargesTotal` — estCost itself is never mutated. */
  chargesTotal: number;
  status: string;
  cancellationFee: number | null;
  feeIfCancelledToday: number | null;
  createdAt: string;
};

export type Payment = {
  id: string;
  amount: number;
  method: string;
  paidDate: string;
  note: string | null;
};

/** One extra charge on a booking — additive; it never changes the booking's estCost. */
export type BookingCharge = { id: string; label: string; amount: number };

export type VenmoPreviewRow = {
  txnId: string;
  date: string;
  amount: number;
  from: string;
  note: string;
};
export type VenmoPreview = {
  matched: (VenmoPreviewRow & {
    endUserId: string;
    clientLabel: string;
    bookingId: string;
    bookingLabel: string;
  })[];
  ambiguous: (VenmoPreviewRow & {
    endUserId: string;
    clientLabel: string;
    candidates: { bookingId: string; label: string; balance: number }[];
  })[];
  unmatched: (VenmoPreviewRow & { reason: string })[];
  alreadyImported: VenmoPreviewRow[];
  ignored: number;
  problems: { row: number; reason: string }[];
};
export type VenmoImportResult = {
  imported: number;
  totalAmount: number;
  skipped: { txnId: string; reason: string }[];
};

export type AnalyticsPayload = {
  tiles: {
    thisMonth: number;
    lastMonth: number;
    outstandingTotal: number;
    outstandingCount: number;
  };
  monthly: { month: string; total: number }[];
  ytd: number;
  quarterly: { q: number; total: number }[];
  byService: { serviceType: string; label: string; total: number }[];
  topClients: {
    endUserId: string;
    name: string | null;
    email: string | null;
    total: number;
    bookings: number;
  }[];
  outstanding: {
    bookingId: string;
    name: string | null;
    email: string | null;
    serviceType: string;
    startDate: string;
    estCost: number;
    chargesTotal: number;
    paidTotal: number;
    balance: number;
    isCancellationFee: boolean;
  }[];
};

export type SitterWindow = '30d' | '90d' | 'quarter' | 'ytd' | 'all';
export type SitterRow = {
  tenantId: string;
  slug: string;
  displayName: string;
  createdAt: string;
  clients: number;
  bookings: number;
  earned: number;
  disabled: boolean;
};
export type SitterRosterResponse = {
  window: SitterWindow;
  totals: { sitters: number; clients: number; bookings: number; earned: number };
  sitters: SitterRow[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True for a 401/403 ApiError — the token is missing, expired, or wrong-tenant. */
export function isAuthExpired(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'Something went wrong — try again.');
  return body;
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = { 'Content-Type': 'application/json' };

export const api = {
  config: (slug: string) => request<TenantConfig>(`/api/${slug}/config`),

  availability: (slug: string, token: string, params: Record<string, string>) =>
    request<Availability>(`/api/${slug}/availability?${new URLSearchParams(params)}`, {
      headers: authHeaders(token),
    }),

  // `prototypeCode` is only present in dev (no email provider configured); in prod the code is
  // emailed and the response carries only `codeId`.
  // `hostOrigin` (the embedding page's origin, from document.referrer) is forwarded as
  // X-Pawservation-Host so the server can gate the reserved demo login to pawservation.com's
  // own pages — the fetch itself is same-origin from the iframe, so its Origin header is the
  // worker's origin on EVERY embedding site and can't distinguish them.
  identify: (slug: string, email: string, hostOrigin?: string) =>
    request<{ codeId: string; prototypeCode?: string }>(`/api/${slug}/identify`, {
      method: 'POST',
      headers: hostOrigin ? { ...jsonHeaders, 'X-Pawservation-Host': hostOrigin } : jsonHeaders,
      body: JSON.stringify({ email }),
    }),

  verify: (slug: string, codeId: string, code: string) =>
    request<{ token: string }>(`/api/${slug}/verify`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ codeId, code }),
    }),

  createBooking: (
    slug: string,
    token: string,
    body: {
      type: string;
      optionKey: string;
      startDate: string;
      endDate?: string;
      /** Range services only: customer-chosen arrival time 'HH:MM'. */
      startTime?: string;
      petIds: string[];
      answers: Record<string, string>;
    },
  ) =>
    request<{ id: string; estCost: number; status: string; demo?: boolean; note?: string }>(
      `/api/${slug}/bookings`,
      {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify(body),
      },
    ),

  me: (slug: string, token: string) =>
    request<{ name: string | null; pets: Pet[] }>(`/api/${slug}/me`, {
      headers: authHeaders(token),
    }),

  monthAvailability: (
    slug: string,
    token: string,
    type: string,
    month: string,
    optionKey?: string,
  ) =>
    request<{ today: string; days: MonthDay[] }>(
      `/api/${slug}/availability/month?type=${encodeURIComponent(type)}&month=${month}` +
        (optionKey ? `&option=${encodeURIComponent(optionKey)}` : ''),
      { headers: authHeaders(token) },
    ),

  myBookings: (slug: string, token: string) =>
    request<{ bookings: Booking[] }>(`/api/${slug}/bookings/mine`, {
      headers: authHeaders(token),
    }),
};

export const adminApi = {
  customers: {
    list: (slug: string, token: string) =>
      request<{ customers: Customer[] }>(`/api/${slug}/admin/customers`, {
        headers: authHeaders(token),
      }),
    add: (
      slug: string,
      token: string,
      email: string,
      name: string,
      phone: string,
      petName: string,
      petType: string,
    ) =>
      request<{ id: string; status: string; created: boolean }>(`/api/${slug}/admin/customers`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ email, name, phone, petName, petType }),
      }),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    setVenmo: (slug: string, token: string, id: string, venmoUsername: string | null) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'PATCH',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ venmoUsername }),
      }),
    addPet: (
      slug: string,
      token: string,
      endUserId: string,
      name: string,
      petType: string,
      notes: string,
    ) =>
      request<{ id: string; name: string; petType: string }>(
        `/api/${slug}/admin/customers/${endUserId}/pets`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify({ name, petType, notes }),
        },
      ),
    removePet: (slug: string, token: string, endUserId: string, petId: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${endUserId}/pets/${petId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    addPetOwner: (slug: string, token: string, petId: string, endUserId: string) =>
      request<unknown>(`/api/${slug}/admin/pets/${petId}/owners`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ endUserId }),
      }),
    removePetOwner: (slug: string, token: string, petId: string, endUserId: string) =>
      request<unknown>(`/api/${slug}/admin/pets/${petId}/owners/${endUserId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    setPetDeceased: (slug: string, token: string, petId: string, deceased: boolean) =>
      request<unknown>(`/api/${slug}/admin/pets/${petId}`, {
        method: 'PATCH',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ deceased }),
      }),
    import: (slug: string, token: string, csv: string, sendInvites: boolean) =>
      request<ImportResult>(`/api/${slug}/admin/customers/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, sendInvites }),
      }),
    sendWelcome: (slug: string, token: string, id: string) =>
      request<{ ok: true }>(`/api/${slug}/admin/customers/${id}/welcome`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
  },
  payments: {
    list: (slug: string, token: string, bookingId: string) =>
      request<{ payments: Payment[] }>(`/api/${slug}/admin/bookings/${bookingId}/payments`, {
        headers: authHeaders(token),
      }),
    record: (
      slug: string,
      token: string,
      bookingId: string,
      body: { amount: number; method: string; paidDate: string; note?: string },
    ) =>
      request<{ payment: Payment; paidTotal: number }>(
        `/api/${slug}/admin/bookings/${bookingId}/payments`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(body),
        },
      ),
    remove: (slug: string, token: string, bookingId: string, paymentId: string) =>
      request<unknown>(`/api/${slug}/admin/bookings/${bookingId}/payments/${paymentId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    venmoPreview: (slug: string, token: string, csv: string) =>
      request<VenmoPreview>(`/api/${slug}/admin/payments/venmo/preview`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv }),
      }),
    venmoImport: (
      slug: string,
      token: string,
      csv: string,
      choices: { txnId: string; bookingId: string }[],
    ) =>
      request<VenmoImportResult>(`/api/${slug}/admin/payments/venmo/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, choices }),
      }),
  },
  charges: {
    list: (slug: string, token: string, bookingId: string) =>
      request<{ charges: BookingCharge[] }>(`/api/${slug}/admin/bookings/${bookingId}/charges`, {
        headers: authHeaders(token),
      }),
    add: (
      slug: string,
      token: string,
      bookingId: string,
      charge: { label: string; amount: number },
    ) =>
      request<{ charge: BookingCharge; chargesTotal: number }>(
        `/api/${slug}/admin/bookings/${bookingId}/charges`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(charge),
        },
      ),
    remove: (slug: string, token: string, bookingId: string, chargeId: string) =>
      request<void>(`/api/${slug}/admin/bookings/${bookingId}/charges/${chargeId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
  },
  analytics: {
    get: (slug: string, token: string) =>
      request<AnalyticsPayload>(`/api/${slug}/admin/analytics`, { headers: authHeaders(token) }),
  },
  bookings: {
    list: (slug: string, token: string) =>
      request<{ bookings: AdminBooking[] }>(`/api/${slug}/admin/bookings`, {
        headers: authHeaders(token),
      }),
    setStatus: (
      slug: string,
      token: string,
      id: string,
      status: 'confirmed' | 'declined' | 'cancelled',
      // Only sent when the sitter opts to charge the prospective cancellation fee; the server
      // ignores it for non-cancel transitions, so it's omitted unless explicitly true.
      chargeFee?: boolean,
    ) =>
      request<{ status: string; notified: boolean; cancellationFee: number | null }>(
        `/api/${slug}/admin/bookings/${id}/status`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify(chargeFee ? { status, chargeFee: true } : { status }),
        },
      ),
  },
  calendar: {
    start: (slug: string, token: string) =>
      request<{ url: string }>(`/api/${slug}/admin/providers/calendar/oauth/start`, {
        headers: authHeaders(token),
      }),
    disconnect: (slug: string, token: string) =>
      request<{ status: string }>(`/api/${slug}/admin/providers/calendar/disconnect`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
    /** Creates a dedicated "Pawservation — Pet bookings" calendar in the sitter's Google account. */
    createPetCalendar: (slug: string, token: string) =>
      request<{ calendarId: string; summary: string }>(
        `/api/${slug}/admin/providers/calendar/create-calendar`,
        { method: 'POST', headers: authHeaders(token) },
      ),
    setCalendarId: (slug: string, token: string, calendarId: string) =>
      request<unknown>(`/api/${slug}/admin/providers/calendar/calendar-id`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ calendarId }),
      }),
  },
  // Explicit prices for a specific set of pets (PetGroupPricing) — upsert/delete-ONE, mirroring
  // server/routes/admin.ts's routes 1:1. Consumed by the account-card rate editor.
  petGroupRates: {
    list: (slug: string, token: string) =>
      request<{ rates: PetGroupRate[] }>(`/api/${slug}/admin/pet-group-rates`, {
        headers: authHeaders(token),
      }),
    upsert: (
      slug: string,
      token: string,
      body: { serviceType: string; optionKey: string; petIds: string[]; rate: number },
    ) =>
      request<{ id: string; groupKey: string }>(`/api/${slug}/admin/pet-group-rates`, {
        method: 'PUT',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify(body),
      }),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/pet-group-rates/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
  },
};

export const owner = {
  sitters: (token: string, window: SitterWindow) =>
    request<SitterRosterResponse>(`/api/owner/sitters?window=${window}`, {
      headers: authHeaders(token),
    }),
  sitterDetail: (token: string, tenantId: string, window: SitterWindow) =>
    request<AnalyticsPayload>(
      `/api/owner/sitters/${encodeURIComponent(tenantId)}?window=${window}`,
      { headers: authHeaders(token) },
    ),
  setSitterDisabled: (token: string, tenantId: string, disabled: boolean) =>
    request<{ disabled: boolean }>(`/api/owner/sitters/${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      headers: { ...jsonHeaders, ...authHeaders(token) },
      body: JSON.stringify({ disabled }),
    }),
  removeSitter: (token: string, tenantId: string) =>
    request<unknown>(`/api/owner/sitters/${encodeURIComponent(tenantId)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),
};

/**
 * Token storage that survives the Wix sandbox denying sessionStorage: in-memory first,
 * sessionStorage best-effort. Losing the token just means re-identifying.
 *
 * Keys are PER-SLUG: every tenant's widget shares the same origin (one workers.dev host),
 * so two embedded widgets on one page would otherwise read each other's tokens — found
 * live in the side-by-side demo as a 403 "Wrong tenant." in the second widget.
 */
const memoryTokens = new Map<string, string>();
const storageKey = (slug: string) => `pawservation-embed-token:${slug}`;
const legacyStorageKey = (slug: string) => `pawbook-embed-token:${slug}`; // pre-rebrand; migrate-once

export function getToken(slug: string): string | null {
  const inMemory = memoryTokens.get(slug);
  if (inMemory) return inMemory;
  try {
    let stored = sessionStorage.getItem(storageKey(slug));
    if (!stored) {
      stored = sessionStorage.getItem(legacyStorageKey(slug));
      if (stored) {
        sessionStorage.setItem(storageKey(slug), stored); // migrate once
        sessionStorage.removeItem(legacyStorageKey(slug));
      }
    }
    if (stored) memoryTokens.set(slug, stored);
    return stored;
  } catch {
    /* storage denied — stateless-per-load mode */
    return null;
  }
}

export function setToken(slug: string, token: string | null): void {
  if (token) memoryTokens.set(slug, token);
  else memoryTokens.delete(slug);
  try {
    if (token) sessionStorage.setItem(storageKey(slug), token);
    else {
      sessionStorage.removeItem(storageKey(slug));
      sessionStorage.removeItem(legacyStorageKey(slug));
    }
  } catch {
    /* storage denied — stateless-per-load mode */
  }
}
