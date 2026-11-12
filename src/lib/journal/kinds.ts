// Client-safe journal constants: the schema, the actions and the client components share them.
export const JOURNAL_SUBJECTS = ["buy_event", "watch_item", "target"] as const;
export const JOURNAL_KINDS = ["thesis", "review", "note"] as const;
export const JOURNAL_MAX_BODY = 4000;

export type JournalSubject = (typeof JOURNAL_SUBJECTS)[number];
export type JournalKind = (typeof JOURNAL_KINDS)[number];
