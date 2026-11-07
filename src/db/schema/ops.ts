import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const syncStatusEnum = pgEnum("sync_status", [
  "running",
  "completed",
  "failed",
  "skipped",
  "holiday",
]);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(),
    broker: text("broker"),
    status: syncStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    counts: jsonb("counts").$type<Record<string, number | string>>().notNull().default({}),
    error: text("error"),
    cursor: jsonb("cursor"),
  },
  (t) => [index("sync_runs_job_started_at_idx").on(t.job, t.startedAt.desc())],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
