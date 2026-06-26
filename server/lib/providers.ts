import type { ProviderConnection } from '../types';

/**
 * Capability→adapter registry (mirrors the shelved Plan 4 shape): adding a provider is a
 * registry entry, never a schema migration. All adapters are STUBS in the prototype — the
 * connect flow flips persisted status only; real OAuth is a graduation task (PRD FR18).
 */

export type CapabilityDescriptor = {
  capability: string;
  provider: string;
  label: string;
};

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  { capability: 'calendar', provider: 'google-calendar', label: 'Google Calendar' },
  { capability: 'crm', provider: 'notion', label: 'Notion' },
  { capability: 'email', provider: 'gmail', label: 'Gmail' },
];

export type ProviderView = CapabilityDescriptor & {
  status: 'disconnected' | 'connected-stub';
  connectedAt: string | null;
};

/** Merge the static registry with a tenant's persisted connection rows. */
export function providerViews(
  connections: ProviderConnection[],
  registry: readonly CapabilityDescriptor[] = CAPABILITIES,
): ProviderView[] {
  return registry.map((descriptor) => {
    const row = connections.find((c) => c.Capability === descriptor.capability);
    return {
      ...descriptor,
      status: row?.Status ?? 'disconnected',
      connectedAt: row?.ConnectedAt ?? null,
    };
  });
}

export function findCapability(capability: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.find((c) => c.capability === capability);
}
