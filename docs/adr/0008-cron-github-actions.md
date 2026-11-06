# 0008. Cron in GitHub Actions, tracked in sync_runs

- Status: Accepted
- Date: 2026-11-11

## Context

Sync, price and EOD jobs must run on weekday schedules at zero cost. Vercel Hobby allows only daily cron with loose timing, and functions stop at 300 s.

## Options considered

1. Vercel cron: zero setup, but Hobby is limited to once a day per job with hour-level jitter, too coarse for 15-minute prices.
2. GitHub Actions `schedule` + `curl POST /api/cron/<job>`: free, minute-level schedules (with best-effort delay), manual `workflow_dispatch`; scheduled workflows are auto-disabled after 60 days without repo activity.
3. External cron service: another account and secret holder.

## Decision

Option 2. Each workflow POSTs with a `CRON_SECRET` bearer (compared in constant time). The route opens a `sync_runs` row per run (running → completed/failed/skipped), which is the only observability. A per-job advisory lock plus a 10-minute window makes overlapping calls record `skipped`; older `running` rows are marked failed (a Vercel kill never reaches our `finally`). Long work is chunked with a cursor stored on the row. A monthly keepalive workflow re-enables every cron workflow through the API with the built-in `GITHUB_TOKEN` (`actions: write`), which beats the 60-day auto-disable without a PAT.

## Consequences

- Schedules are in UTC and GitHub runs them late, sometimes by many minutes. Staleness checks are schedule-aware with per-job grace (`src/lib/jobs/schedule.ts`), and the US price window is wide enough for both NY offsets, with the job deciding via `isMarketOpen`.
- `src/lib/jobs/schedule.ts` mirrors the workflow crons by hand; change both together.
- Market holidays are not modelled yet.
