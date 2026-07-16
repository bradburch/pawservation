---
title: Pawbook
description: Open-source, embeddable multi-tenant booking widget for pet-sitting businesses
---

# Pawbook

**An embeddable booking widget for pet-sitting and boarding businesses — drop a live
calendar into any website with one `<script>` tag.**

Pawbook is a full-stack, production-shaped side project: a multi-tenant SaaS booking
platform built on the Cloudflare edge (Workers, D1, KV), with a React embed widget, a
sitter-facing admin dashboard, and a pure, dependency-free booking/pricing engine at
its core. It's the kind of problem a small team actually gets paid to solve — tenancy
isolation, calendar conflicts, capacity limits, payments, and a widget that has to
behave inside someone else's website — built solo, end to end, with the engineering
guardrails (tests, CI, security review, design specs) that a shipped product needs.

## Highlights

- **Real product surface area, not a toy CRUD app** — multi-tenant isolation, capacity
  and conflict rules, per-service booking constraints, CSV bulk import, payment/earnings
  tracking, and two-way Google Calendar sync, all shipped as incremental, reviewed PRs.
- **Edge-native architecture** — Cloudflare Workers (Hono) + D1 (SQLite) + KV, chosen for
  low-latency global delivery of a widget that lives on third-party sites.
- **Embeds anywhere, safely** — a single `<script>` tag injects an auto-resizing iframe;
  every `postMessage` is validated by origin _and_ source, so the widget can't be hijacked
  by the host page or vice versa.
- **Zero-dependency core** — the booking, date, and pricing logic in `src/shared/` is pure
  TypeScript with no runtime dependencies, so the rules that decide what a customer can
  book are easy to test in isolation and can't be broken by a transitive dependency update.
- **Two real auth flows** — passwordless email-code sessions for customers and password +
  JWT sessions for tenant admins, including invite-only customer lists.
- **Tested like it matters** — 46+ test files backed by in-memory SQLite (`node:sqlite`),
  gating a CI pipeline that runs typecheck, lint, format, and build on every PR before an
  automatic deploy to Cloudflare on merge to `main`.
- **Security-conscious by habit** — a documented [`SECURITY.md`](../SECURITY.md) policy,
  and commit history that includes dedicated security-review passes (closing
  prototype-pollution and race-condition findings) rather than shipping and forgetting.
- **Design-first workflow** — every non-trivial feature (calendar OAuth, custom services,
  CSV import, earnings analytics) started as a written design spec before code, visible in
  [`docs/superpowers/specs`](./superpowers/specs).

## Tech stack

`TypeScript` · `React` · `Hono` · `Cloudflare Workers` · `D1 (SQLite)` · `KV` ·
`Vite` · `Vitest` · `ESLint` · `Prettier` · `GitHub Actions`

## Try it

- Widget demo: `/demo` (two sample tenants side by side)
- Admin dashboard: `/admin`
- Source: see the main [README](../README.md) for local setup and architecture.
