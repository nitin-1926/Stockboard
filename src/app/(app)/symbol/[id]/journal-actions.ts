"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/access";
import { createEntry, deleteEntry, editEntry, JournalError } from "@/lib/journal/actions";
import type { JournalKind, JournalSubject } from "@/lib/journal/kinds";

// Thin wrappers: the actor checks live in src/lib/journal/actions.ts (suggest / edit_own).
// Expected failures come back as { error }; "Forbidden" still throws, since the UI never
// renders a control the actor can't use. The author is never read from the form.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JournalFormResult = { ok: true } | { error: string } | null;

function refresh(instrumentId: string) {
  revalidatePath(`/symbol/${instrumentId}`);
  revalidatePath("/"); // Due for review
  revalidatePath("/targets");
  revalidatePath("/watchlist");
}

async function expected(fn: () => Promise<{ instrumentId: string }>): Promise<JournalFormResult> {
  try {
    refresh((await fn()).instrumentId);
    return { ok: true };
  } catch (e) {
    if (e instanceof JournalError) return { error: e.message };
    throw e;
  }
}

/** `subject` is "<subject_type>:<id>" from the composer's picker. */
export async function createJournalAction(_prev: JournalFormResult, fd: FormData): Promise<JournalFormResult> {
  const actor = await requireActor();
  const [type, id] = String(fd.get("subject") ?? "").split(":");
  if (!UUID.test(id ?? "")) return { error: "Pick what this note is about." };
  return expected(() =>
    createEntry(actor, {
      subjectType: type as JournalSubject,
      subjectId: id,
      kind: String(fd.get("kind") ?? "") as JournalKind,
      body: String(fd.get("body") ?? ""),
    }),
  );
}

export async function editJournalAction(id: string, body: string): Promise<JournalFormResult> {
  const actor = await requireActor();
  if (!UUID.test(id)) return { error: "Bad entry id." };
  return expected(() => editEntry(actor, id, String(body)));
}

export async function deleteJournalAction(id: string): Promise<JournalFormResult> {
  const actor = await requireActor();
  if (!UUID.test(id)) return { error: "Bad entry id." };
  return expected(() => deleteEntry(actor, id));
}
