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
  shape: 'range' | 'single';
  rateUnit: 'night' | 'day' | 'visit';
  hasDuration: boolean;
  options: ServiceOption[];
  questions: ServiceQuestion[];
  acceptedPetTypes: string[] | null;
  cancellationTiers: { withinDays: number; percent: number }[] | null;
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

export type Pet = { id: string; name: string; petType: string; notes?: string | null };
export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
};

export type Availability =
  { available: true; estCost: number; nights?: number } | { available: false; reason: string };

export type Booking = {
  id: string;
  type: string;
  startDate: string;
  endDate: string | null;
  petCount: number;
  estCost: number | null;
  cancellationFee: number | null;
  status: string;
  pets: string[];
};

export type Customer = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  status: 'invited' | 'active';
  invitedAt?: string | null;
  pets: Pet[];
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
  estCost: number | null;
  paidTotal: number;
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

  availability: (slug: string, params: Record<string, string>) =>
    request<Availability>(`/api/${slug}/availability?${new URLSearchParams(params)}`),

  // `prototypeCode` is only present in dev (no email provider configured); in prod the code is
  // emailed and the response carries only `codeId`.
  identify: (slug: string, email: string) =>
    request<{ codeId: string; prototypeCode?: string }>(`/api/${slug}/identify`, {
      method: 'POST',
      headers: jsonHeaders,
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
      petIds: string[];
      answers: Record<string, string>;
    },
  ) =>
    request<{ id: string; estCost: number; status: string }>(`/api/${slug}/bookings`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...authHeaders(token) },
      body: JSON.stringify(body),
    }),

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
    add: (slug: string, token: string, email: string, name: string, phone: string) =>
      request<{ id: string; status: string }>(`/api/${slug}/admin/customers`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ email, name, phone }),
      }),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
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
    import: (slug: string, token: string, csv: string, sendInvites: boolean) =>
      request<ImportResult>(`/api/${slug}/admin/customers/import`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ csv, sendInvites }),
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
    setCalendarId: (slug: string, token: string, calendarId: string) =>
      request<unknown>(`/api/${slug}/admin/providers/calendar/calendar-id`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ calendarId }),
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
