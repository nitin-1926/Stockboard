"use server";

import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/auth/access";
import { type ImportResult, importConsoleCsv, importUsHistory } from "@/lib/ledger/ingest";

export type ImportState = ImportResult | { error: string } | null;

async function run(fd: FormData, importer: typeof importConsoleCsv): Promise<ImportState> {
  const actor = await authorize("manage");
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file first." };
  try {
    const result = await importer(await file.text(), actor);
    if (!("errors" in result)) revalidatePath("/", "layout");
    return result;
  } catch (e) {
    // Network prefetch (FX, split history) or the transaction failed; nothing was written.
    return { error: `Import failed, nothing was saved: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function importConsoleAction(_prev: ImportState, fd: FormData) {
  return run(fd, importConsoleCsv);
}

export async function importUsAction(_prev: ImportState, fd: FormData) {
  return run(fd, importUsHistory);
}
