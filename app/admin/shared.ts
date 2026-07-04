import { request } from '../shared-ui/api.js';

export type Session = { token: string; slug: string; displayName: string };

export type ServiceOptionForm = {
  optionKey?: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
};
export type ServiceForm = {
  type: string;
  label: string;
  hasDuration: boolean;
  rateUnit: string;
  enabled: boolean;
  options: ServiceOptionForm[];
};
export type Settings = {
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  petTypes: { petType: string; enabled: boolean }[];
  services: ServiceForm[];
  blocked: { id: string; startDate: string; endDate: string | null }[];
  providers: {
    capability: string;
    provider: string;
    label: string;
    authMode: 'oauth' | 'stub';
    status: string;
    connectedAt: string | null;
    calendarId?: string | null;
  }[];
};

export function adminFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}
