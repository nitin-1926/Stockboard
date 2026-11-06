# 0005. Event-sourced ledger with source precedence

- Status: Accepted
- Date: 2026-11-11

## Context

Brokers give us holdings snapshots (qty + average price) and, for Kite, daily fills. Neither gives full trade history, and snapshots lag fills by up to a trading day. Corporate actions change quantity without a trade, and Yahoo reports bonuses as splits. The owner can later import a Console tradebook or US history, or correct a trade by hand. Every number the user sees (lots, realized P&L, LTCG dates, XIRR) derives from what we decide here.

## Options considered

1. Mutable lots table updated on each sync: simple reads, but a late fill or a CSV import means rewriting lots by hand, and mistakes are unrecoverable.
2. Store snapshots only and derive P&L from snapshot diffs at read time: no history of what was inferred vs known, no place for corrections.
3. Append-only `ledger_events` (buy, sell, split, bonus, dividend, opening) as the source of truth, with lots derived by a pure FIFO replay; better sources supersede worse ones through a link table.

## Decision

Option 3.

- Events carry `source` (manual > csv / us_history > fill > inferred / opening) and a unique deterministic `source_ref`, so re-ingesting is a no-op.
- Supersession is a link table `(superseded_id, superseding_id)`, one-to-many: one opening can be replaced by three CSV buys, one inferred buy by several partial fills. Superseded events are kept, never deleted. Bucket, watch-item and journal refs on a superseded buy are copied onto every superseding buy.
- Snapshot inference is residual: replay the ledger as of the snapshot time and infer only the unexplained quantity, so a fill and an inference never double count. Recent fills that cover the gap mean the broker is lagging, and nothing is written.
- A quantity change is checked against corporate actions (ex-date within 14 days before the diff, ratio within 0.5%) before it is treated as a trade. Split and bonus share one ratio convention, so the owner reclassifies by flipping the type; a bonus lot is zero-cost and dated at allotment.
- Lots, realized P&L and the broker-convention (weighted-average) position come from `src/lib/ledger/lots.ts`, which reuses the returns engine's `sellFifo`.

## Consequences

- Corrections are cheap: insert a better event, link it, replay. History is auditable.
- Every read of lots is a replay; fine at personal-portfolio scale, cache per instrument if it ever is not.
- Inference is approximate by design (`approximate` flag, anomaly list); the owner review queue (U18) and imports are how it becomes exact.
- The DB layer must insert remainder events before their link rows and copy refs inside the same transaction.
