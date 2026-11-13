"use server";

import { revalidatePath } from "next/cache";
import { authorize, requireActor } from "@/lib/auth/access";
import { cancelTarget, createTarget, editTarget, TargetError, type TargetFields } from "@/lib/targets/actions";
import { evaluatePendingTargets } from "@/lib/targets/evaluate-job";

// Thin wrappers: the actor checks live in src/lib/targets/actions.ts (suggest / edit_own).
// Expected failures come back as { error }; "Forbidden" still throws, since the UI never
// renders a control the actor can't use. set_by is never read from the form.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh() {
  revalidatePath("/targets");
  revalidatePath("/holdings");
  revalidatePath("/watchlist");
}

export type TargetFormResult = { ok: true } | { error: string } | null;

function fields(fd: FormData): Omit<TargetFields, "instrumentId"> | { error: string } {
  const kind = fd.get("kind") === "stop" ? "stop" : "target";
  const mode = fd.get("mode") === "pct" ? "pct" : "abs";
  const raw = Number(String(fd.get("value") ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return { error: mode === "pct" ? "Enter a percentage above zero." : "Enter a price above zero." };
  // % is entered as a magnitude; the kind gives the direction (target up, stop down).
  const value = mode === "pct" ? (kind === "stop" ? -raw : raw) / 100 : raw;
  if (mode === "pct" && kind === "stop" && raw >= 100) return { error: "A stop can be at most 99.99% below the price." };
  return {
    kind,
    mode,
    value,
    deadline: String(fd.get("deadline") ?? "").slice(0, 10) || null,
    note: String(fd.get("note") ?? "").slice(0, 1000),
  };
}

async function expected(fn: () => Promise<unknown>): Promise<TargetFormResult> {
  try {
    await fn();
    refresh();
    return { ok: true };
  } catch (e) {
    if (e instanceof TargetError) return { error: e.message };
    throw e;
  }
}

/** Create, or edit when `id` is set (edit = new target + the old one cancelled). */
export async function saveTargetAction(_prev: TargetFormResult, fd: FormData): Promise<TargetFormResult> {
  const actor = await requireActor();
  const f = fields(fd);
  if ("error" in f) return f;
  const id = String(fd.get("id") ?? "");
  if (id) {
    if (!UUID.test(id)) return { error: "Bad target id." };
    return expected(() => editTarget(actor, id, f));
  }
  const instrumentId = String(fd.get("instrumentId") ?? "");
  if (!UUID.test(instrumentId)) return { error: "Pick a symbol." };
  return expected(() => createTarget(actor, { ...f, instrumentId }));
}

export async function cancelTargetAction(id: string): Promise<TargetFormResult> {
  const actor = await requireActor();
  if (!UUID.test(id)) return { error: "Bad target id." };
  return expected(() => cancelTarget(actor, id));
}

/** Owner: run the EOD evaluation now against the stored daily bars. */
export async function reevaluateAction(): Promise<{ checked: number; updated: number }> {
  await authorize("manage");
  const r = await evaluatePendingTargets();
  refresh();
  return { checked: r.checked, updated: r.updated };
}
