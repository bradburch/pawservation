# Contributing to Pawservation

Thanks for your interest in contributing! This guide covers how to get set up and what we
expect in a pull request.

## Getting started

1. Fork and clone the repo.
2. Use the pinned Node version: `nvm use` (reads `.nvmrc` → Node 24).
3. Install dependencies: `npm install`.
4. Seed a local database and run the dev server:
   ```bash
   npm run seed:local
   echo 'TOKEN_SECRET=local-dev-secret-change-me' > .dev.vars
   npm run dev
   ```

## Before you open a PR

All of these run in CI and must pass:

```bash
npm run typecheck
npm run lint
npm run format      # use `npm run format:fix` to auto-format
npm test
npm run build
```

## Pull request guidelines

- Keep PRs focused — one logical change per PR.
- Add or update tests for any behavior change. Tests use Vitest with an in-memory SQLite
  database (`server/__tests__/helpers.ts`).
- Don't introduce new runtime dependencies in `src/shared/` — that core is intentionally
  dependency-free.
- Follow the existing code style (enforced by ESLint + Prettier; single quotes, 100-col).
- Use clear commit messages. We loosely follow
  [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `chore:`, `refactor:`, `test:`).

## Reporting bugs and requesting features

Open an issue using the provided templates. For anything security-sensitive, **do not** open a
public issue — follow [SECURITY.md](./SECURITY.md) instead.
