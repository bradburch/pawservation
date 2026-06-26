import { Hono } from 'hono';
import {
  deleteBlockedRange,
  insertBookingRequest,
  listBlockedRanges,
  listPetTypes,
  listProviderConnections,
  listServiceOptions,
  listServices,
  replaceServiceOptions,
  setPetTypeEnabled,
  setProviderStatus,
  setServiceEnabled,
  updateTenantSettings,
} from '../db/repo';
import { adminAuth } from '../lib/middleware';
import { findCapability, providerViews } from '../lib/providers';
import { embedSnippets } from '../lib/snippet';
import { isPetType, isServiceType, PET_TYPES, SERVICE_CATALOG } from '../lib/services';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { isRealDate, isValidDuration, isValidRate } from '../lib/validation';
import type { AppEnv } from '../types';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

type OptionBody = { label?: string; durationMinutes?: number | null; rate?: number };
type ServiceBody = { type?: string; enabled?: boolean; options?: OptionBody[] };
type SettingsBody = {
  displayName?: string;
  accentColor?: string;
  maxBoardingPets?: number;
  petTypes?: string[];
  services?: ServiceBody[];
};

export const adminRoutes = new Hono<AppEnv>()
  .use('/:slug/admin/*', adminAuth)

  .get('/:slug/admin/settings', async (c) => {
    const tenant = c.get('tenant');
    const [services, options, petTypes, blocked, connections] = await Promise.all([
      listServices(c.env.EMBED_PROTO_DB, tenant.Id),
      listServiceOptions(c.env.EMBED_PROTO_DB, tenant.Id),
      listPetTypes(c.env.EMBED_PROTO_DB, tenant.Id),
      listBlockedRanges(c.env.EMBED_PROTO_DB, tenant.Id),
      listProviderConnections(c.env.EMBED_PROTO_DB, tenant.Id),
    ]);
    const enabledByType = new Map(services.map((s) => [s.ServiceType, Boolean(s.Enabled)]));
    return c.json({
      displayName: tenant.DisplayName,
      accentColor: tenant.AccentColor,
      maxBoardingPets: tenant.MaxBoardingPets,
      petTypes: PET_TYPES.map((pt) => ({
        petType: pt,
        enabled: petTypes.some((p) => p.PetType === pt && p.Enabled),
      })),
      services: Object.entries(SERVICE_CATALOG).map(([type, meta]) => ({
        type,
        label: meta.label,
        hasDuration: meta.hasDuration,
        rateUnit: meta.rateUnit,
        enabled: enabledByType.get(type as keyof typeof SERVICE_CATALOG) ?? false,
        options: options
          .filter((o) => o.ServiceType === type)
          .map((o) => ({
            optionKey: o.OptionKey,
            label: o.Label,
            durationMinutes: o.DurationMinutes,
            rate: o.Rate,
          })),
      })),
      blocked: blocked.map((b) => ({ id: b.Id, startDate: b.StartDate, endDate: b.EndDate })),
      providers: providerViews(connections),
    });
  })

  .put('/:slug/admin/settings', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<SettingsBody>().catch(() => ({}) as SettingsBody);

    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : tenant.DisplayName;
    const accentColor =
      typeof body.accentColor === 'string' ? body.accentColor : tenant.AccentColor;
    const maxBoardingPets = body.maxBoardingPets ?? tenant.MaxBoardingPets;
    const petTypes = body.petTypes;
    const services = body.services ?? [];

    if (!displayName) return c.json({ error: 'Display name required.' }, 400);
    if (!COLOR_RE.test(accentColor)) return c.json({ error: 'Accent color must be #rrggbb.' }, 400);
    if (!Number.isInteger(maxBoardingPets) || maxBoardingPets < 1 || maxBoardingPets > 50)
      return c.json({ error: 'Boarding capacity must be 1-50 pets.' }, 400);
    if (petTypes !== undefined) {
      if (!Array.isArray(petTypes) || !petTypes.every(isPetType))
        return c.json({ error: 'Unknown pet type.' }, 400);
    }
    for (const svc of services) {
      if (!isServiceType(svc.type)) return c.json({ error: 'Unknown service type.' }, 400);
      const meta = SERVICE_CATALOG[svc.type];
      const opts = svc.options ?? [];
      if (svc.enabled && opts.length === 0)
        return c.json({ error: `${meta.label} needs at least one price option.` }, 400);
      // Non-duration services derive every optionKey as 'standard', so more than one would collide
      // on the (TenantId, ServiceType, OptionKey) UNIQUE constraint mid-write. Reject up front.
      if (!meta.hasDuration && opts.length > 1)
        return c.json({ error: `${meta.label} takes a single price.` }, 400);
      for (const o of opts) {
        if (!isValidRate(o.rate)) return c.json({ error: 'Rates must be whole dollars ≥ 1.' }, 400);
        if (meta.hasDuration && !isValidDuration(o.durationMinutes))
          return c.json({ error: 'Durations must be whole minutes ≥ 1.' }, 400);
      }
      if (meta.hasDuration) {
        const mins = opts.map((o) => o.durationMinutes);
        if (new Set(mins).size !== mins.length)
          return c.json({ error: 'Duplicate durations for one service.' }, 400);
      }
    }

    await updateTenantSettings(c.env.EMBED_PROTO_DB, tenant.Id, {
      displayName,
      accentColor,
      maxBoardingPets,
    });
    if (petTypes !== undefined) {
      for (const pt of PET_TYPES)
        await setPetTypeEnabled(c.env.EMBED_PROTO_DB, tenant.Id, pt, petTypes.includes(pt));
    }
    for (const svc of services) {
      const svcType = svc.type as keyof typeof SERVICE_CATALOG;
      const meta = SERVICE_CATALOG[svcType];
      await setServiceEnabled(c.env.EMBED_PROTO_DB, tenant.Id, svcType, svc.enabled ?? false);
      await replaceServiceOptions(
        c.env.EMBED_PROTO_DB,
        tenant.Id,
        svcType,
        (svc.options ?? []).map((o) => ({
          optionKey: meta.hasDuration ? `d${o.durationMinutes}` : 'standard',
          label: o.label?.trim() || (meta.hasDuration ? `${o.durationMinutes} min` : 'Standard'),
          durationMinutes: meta.hasDuration ? (o.durationMinutes as number) : null,
          rate: o.rate as number,
          rateUnit: meta.rateUnit,
        })),
      );
    }

    // The widget reads tenant config through the KV-cached resolution seam (PRD FR19).
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.body(null, 204);
  })

  .post('/:slug/admin/blocked', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ startDate?: string; endDate?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const start = typeof body.startDate === 'string' ? body.startDate : '';
    const end = typeof body.endDate === 'string' ? body.endDate : '';
    if (!isRealDate(start) || !isRealDate(end) || end <= start)
      return c.json({ error: 'Provide a valid range (end is exclusive).' }, 400);
    const id = await insertBookingRequest(c.env.EMBED_PROTO_DB, tenant.Id, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: start,
      endDate: end,
      optionKey: null,
      petType: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    return c.json({ id }, 201);
  })

  .delete('/:slug/admin/blocked/:id', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deleteBlockedRange(c.env.EMBED_PROTO_DB, tenant.Id, c.req.param('id'));
    if (!deleted) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })

  .get('/:slug/admin/snippet', (c) => {
    const tenant = c.get('tenant');
    return c.json(embedSnippets(new URL(c.req.url).origin, tenant.Slug));
  })

  .post('/:slug/admin/providers/:capability/connect', async (c) => {
    const tenant = c.get('tenant');
    const descriptor = findCapability(c.req.param('capability'));
    if (!descriptor) return c.json({ error: 'Unknown capability.' }, 404);
    await setProviderStatus(
      c.env.EMBED_PROTO_DB,
      tenant.Id,
      descriptor.capability,
      descriptor.provider,
      'connected-stub',
    );
    return c.json({ status: 'connected-stub' });
  });
