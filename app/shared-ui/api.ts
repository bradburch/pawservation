/** Tiny same-origin API client for the widget + admin pages. */

export type ServiceOption = {
  optionKey: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
};
export type ServiceQuestion = {
  id: string;
  label: string;
  type: 'text' | 'yesno' | 'number' | 'select';
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  options?: string[];
};
export type ServiceConfig = {
  type: string;
  label: string;
  icon: string; // widget icon key: bed|home|sun|paw|clipboard
  shape: 'range' | 'single';
  rateUnit: 'night' | 'day' | 'visit';
  hasDuration: boolean;
  options: ServiceOption[];
  questions: ServiceQuestion[];
  minNights: number | null;
  maxNights: number | null;
  minPetCount: number | null;
  maxPetCount: number | null;
};
export type TenantConfig = {
  slug: string;
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  petTypes: string[];
  services: ServiceConfig[];
};

export type Pet = { id: string; name: string; petType: 'dog' | 'cat' };
export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
};

export type Availability =
  | { available: true; estCost: number; nights?: number }
  | { available: false; reason: string };

export type Booking = {
  id: string;
  type: string;
  startDate: string;
  endDate: string | null;
  petCount: number;
  estCost: number | null;
  status: string;
  pets: string[];
};

export type Customer = {
  id: string;
  email: string;
  name: string | null;
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
  status: string;
  createdAt: string;
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

  monthAvailability: (slug: string, token: string, type: string, month: string) =>
    request<{ today: string; days: MonthDay[] }>(
      `/api/${slug}/availability/month?type=${encodeURIComponent(type)}&month=${month}`,
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
    add: (slug: string, token: string, email: string, name: string) =>
      request<{ id: string; status: string }>(`/api/${slug}/admin/customers`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ email, name }),
      }),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    addPet: (slug: string, token: string, endUserId: string, name: string, petType: string) =>
      request<{ id: string; name: string; petType: string }>(
        `/api/${slug}/admin/customers/${endUserId}/pets`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, ...authHeaders(token) },
          body: JSON.stringify({ name, petType }),
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
    ) =>
      request<{ status: string; notified: boolean }>(`/api/${slug}/admin/bookings/${id}/status`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ status }),
      }),
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

/**
 * Token storage that survives the Wix sandbox denying sessionStorage: in-memory first,
 * sessionStorage best-effort. Losing the token just means re-identifying.
 *
 * Keys are PER-SLUG: every tenant's widget shares the same origin (one workers.dev host),
 * so two embedded widgets on one page would otherwise read each other's tokens — found
 * live in the side-by-side demo as a 403 "Wrong tenant." in the second widget.
 */
const memoryTokens = new Map<string, string>();
const storageKey = (slug: string) => `pawbook-embed-token:${slug}`;

export function getToken(slug: string): string | null {
  const inMemory = memoryTokens.get(slug);
  if (inMemory) return inMemory;
  try {
    const stored = sessionStorage.getItem(storageKey(slug));
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
    else sessionStorage.removeItem(storageKey(slug));
  } catch {
    /* storage denied — stateless-per-load mode */
  }
}
