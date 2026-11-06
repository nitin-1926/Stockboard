# 0004. Drizzle on Neon with a single WebSocket Pool driver

- Status: Accepted
- Date: 2026-11-11

## Context

The app needs Postgres access from Vercel functions (Fluid compute) and from GitHub-Actions-triggered cron routes. Sync and ledger writes need interactive transactions (read, decide, write, under row locks). Better Auth (U4) needs a client that supports transactions too. The plan proposed two drivers: `neon-http` for reads and a `neon-serverless` Pool for transactional writes.

## Options considered

1. Two drivers (`neon-http` reads + `neon-serverless` Pool writes): HTTP is slightly faster for one-shot cold reads, but every caller must pick the right client, and anything that grows a transaction must switch clients.
2. One `neon-serverless` Pool for everything, attached with `attachDatabasePool` from `@vercel/functions`: one client, interactive transactions everywhere, Fluid compute reuses connections across invocations and closes idle ones before suspension.

## Decision

Option 2. A single module, `src/db/index.ts`, exports a module-scoped `Pool` and a Drizzle `db` built on `drizzle-orm/neon-serverless`. Node 22 ships a global `WebSocket`, so the `ws` package is not needed. The same client is handed to Better Auth. Migrations use `drizzle-kit generate` then `drizzle-kit migrate` against `DATABASE_URL_UNPOOLED`; `push` is never used against main.

## Consequences

- No "which client?" decision per call site, and no transaction-unsafe client to misuse.
- A cold function pays the WebSocket handshake on its first query (tens of ms). If read latency on cold starts becomes a measured problem, add a `neon-http` client for hot read paths then, via a new ADR.
- Money and quantity columns are `numeric` mapped to strings, so values never touch JS floats; arithmetic uses a decimal library chosen in U12.
