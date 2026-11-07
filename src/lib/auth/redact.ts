// Central "hide amounts" redaction. Runs on the server in the mappers that build page
// DTOs, so restricted amounts never reach the client payload (not a CSS mask).
//
// Pattern for later units (U13+): each view module that builds a DTO declares a
// FieldPolicy next to the DTO type listing its AMOUNT fields: quantities, invested/cost,
// value, absolute P&L (total, realized, unrealized, day), dividends in money, margins,
// lot sizes, cash flows. Prices and percentages are NOT amounts and stay. Then:
//
//   const actor = await requireActor();
//   return rows.map((r) => redactForActor(actor, toDto(r), HOLDING_POLICY));
//
// Redacted fields are ABSENT (deleted), never zeroed, so the UI must render a dash for
// a missing key (`src/components/money.tsx`, U13). Add a redact test per view.
import type { PositionPnl } from "@/lib/returns/pnl";
import type { Actor } from "./access";

export type FieldPolicy<T> = readonly (keyof T)[];
/** A DTO as a restricted actor may receive it: amount fields become optional. */
export type Redacted<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export function redactForActor<T extends object, K extends keyof T>(
  actor: Actor,
  dto: T,
  policy: readonly K[],
): Redacted<T, K> {
  if (!actor.hideAmounts) return dto;
  const out = { ...dto };
  for (const k of policy) delete out[k];
  return out;
}

/** Output of `positionPnl` (src/lib/returns/pnl.ts): every field is an amount. */
export const POSITION_PNL_POLICY = [
  "openQty",
  "costNative",
  "costInr",
  "valueNative",
  "valueInr",
  "unrealizedNative",
  "unrealizedInr",
  "realizedNative",
  "realizedInr",
  "dividendsGrossInr",
  "dividendsNetInr",
  "totalReturnInr",
  "flows",
] as const satisfies FieldPolicy<PositionPnl>;
