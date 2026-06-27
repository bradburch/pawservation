/** Tiny same-origin API client for the widget + admin pages. */

export type ServiceOption = {
  optionKey: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
};
export type ServiceConfig = {
  type: string;
  label: string;
  shape: 'range' | 'single';
  rateUnit: 'night' | 'day' | 'visit';
  hasDuration: boolean;
  options: ServiceOption[];
};
export type TenantConfig = {
  slug: string;
  displayName: string;
  accentColor: string;
  maxBoardingPets: number;
  petTypes: string[];
  services: ServiceConfig[];
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
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
      petType?: string;
      startDate: string;
      endDate?: string;
      petCount: number;
    },
  ) =>
    request<{ id: string; estCost: number; status: string }>(`/api/${slug}/bookings`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...authHeaders(token) },
      body: JSON.stringify(body),
    }),

  myBookings: (slug: string, token: string) =>
    request<{ bookings: Booking[] }>(`/api/${slug}/bookings/mine`, {
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
