// Server-only view module: Kite equity margins for the Overview card (U10 writes margins_latest).
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { marginsLatest } from "@/db/schema";
import { type Actor, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, type Redacted, redactForActor } from "@/lib/auth/redact";

export interface MarginsDto {
  /** Available cash. */
  cash: number;
  /** Margin in use. */
  used: number;
  /** Available to trade. */
  net: number;
  asOf: string;
}

/** Every money field: hide-amounts viewers get only the as-of time. */
export const MARGINS_POLICY = ["cash", "used", "net"] as const satisfies FieldPolicy<MarginsDto>;
export type MarginsView = Redacted<MarginsDto, (typeof MARGINS_POLICY)[number]>;

/** Pure. Null until the first Kite sync. */
export function buildMarginsView(row: typeof marginsLatest.$inferSelect | null, actor: Actor): MarginsView | null {
  if (!row) return null;
  const dto: MarginsDto = { cash: Number(row.cash), used: Number(row.used), net: Number(row.net), asOf: row.asOf.toISOString() };
  return redactForActor(actor, dto, MARGINS_POLICY);
}

export async function getMarginsView(): Promise<MarginsView | null> {
  const actor = await requireActor();
  const [row] = await db.select().from(marginsLatest).where(eq(marginsLatest.broker, "kite"));
  return buildMarginsView(row ?? null, actor);
}
