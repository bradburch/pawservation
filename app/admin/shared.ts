import type { ServiceConstraints, ServiceOption, ServiceQuestion } from '../../src/shared/index.js';
import { request } from '../shared-ui/api.js';

export type Session = { token: string; slug: string; displayName: string };

// `optionKey`/`id` are omitted-until-first-save on the client (the server derives/assigns them),
// so both forms widen that one field to optional relative to the shared, field-complete shape.
export type ServiceOptionForm = Omit<ServiceOption, 'optionKey'> & { optionKey?: string };
export type QuestionForm = Omit<ServiceQuestion, 'id'> & { id?: string };
export type ServiceForm = ServiceConstraints & {
  type: string;
  label: string;
  hasDuration: boolean;
  rateUnit: string;
  shape: 'range' | 'single';
  enabled: boolean;
  options: ServiceOptionForm[];
  questions: QuestionForm[];
};
export type Settings = {
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  petTypes: { petType: string; enabled: boolean }[];
  services: ServiceForm[];
  blocked: { id: string; startDate: string; endDate: string | null }[];
  calendar: {
    status: string;
    connectedAt: string | null;
    calendarId: string | null;
  };
};

/** Shared prop shape for sections that edit the staged, save-button-gated `settings` draft. */
export type SettingsSectionProps = {
  settings: Settings;
  setSettings: (settings: Settings) => void;
};

/**
 * The PUT `/admin/settings` request body (mirrors `SettingsBody`/`ServiceBody` in
 * server/routes/admin.ts). Built from the same shared/derived field types as `Settings` so that
 * a field added to `ServiceOption`/`ServiceQuestion`/`ServiceConstraints` — or dropped by a hand
 * mapping in `save()` — surfaces as a compile error there instead of silently going missing on
 * the wire.
 */
export type ServicePayload = ServiceConstraints & {
  type: string;
  enabled: boolean;
  options: ServiceOptionForm[];
  questions: QuestionForm[];
};
export type SettingsPayload = {
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  petTypes: string[];
  services: ServicePayload[];
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
