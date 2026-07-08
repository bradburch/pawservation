import { request } from '../shared-ui/api.js';

export type Session = { token: string; slug: string; displayName: string };

export type ServiceOptionForm = {
  optionKey?: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
};
export type QuestionForm = {
  id?: string;
  label: string;
  type: 'text' | 'yesno' | 'number' | 'select';
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  options?: string[];
};
export type ServiceForm = {
  type: string;
  label: string;
  icon: string;
  hasDuration: boolean;
  rateUnit: string;
  shape: 'range' | 'single';
  custom: boolean;
  enabled: boolean;
  options: ServiceOptionForm[];
  questions: QuestionForm[];
  minNights: number | null;
  maxNights: number | null;
  minPetCount: number | null;
  maxPetCount: number | null;
};
export type ServiceTemplate = { id: string; label: string };
export type Settings = {
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  petTypes: { petType: string; enabled: boolean }[];
  services: ServiceForm[];
  templates: ServiceTemplate[];
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

/** Shared prop shape for sections that edit the staged, save-button-gated `settings` draft. */
export type SettingsSectionProps = {
  settings: Settings;
  setSettings: (settings: Settings) => void;
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
