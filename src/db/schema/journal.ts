import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { JOURNAL_KINDS, JOURNAL_MAX_BODY, JOURNAL_SUBJECTS } from "../../lib/journal/kinds";
import { instruments } from "./market";

// Trade journal (U20): "why" notes on a buy, a watch item or a target. subject_id is
// polymorphic (no FK); src/lib/journal/actions.ts checks the subject exists and fills
// instrument_id from it, so the symbol page reads one instrument's notes with one index.
// A superseded buy's entries are moved to the first superseding buy (REF_COPIERS).

export const journalSubjectEnum = pgEnum("journal_subject", JOURNAL_SUBJECTS);
export const journalKindEnum = pgEnum("journal_kind", JOURNAL_KINDS);

/** `author` is the actor's lowercased email (the edit_own resource owner). Deleting sets `deleted_at`. */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: journalSubjectEnum("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    kind: journalKindEnum("kind").notNull(),
    body: text("body").notNull(),
    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("journal_entries_instrument_idx").on(t.instrumentId),
    index("journal_entries_subject_idx").on(t.subjectType, t.subjectId),
    check("journal_entries_body_len", sql`length(${t.body}) between 1 and ${sql.raw(String(JOURNAL_MAX_BODY))}`),
    check("journal_entries_author_lower", sql`${t.author} = lower(${t.author})`),
  ],
);
