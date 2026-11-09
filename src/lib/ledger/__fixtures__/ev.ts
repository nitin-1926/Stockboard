import type { LedgerEvent, Snapshot } from "../types";

/** Test builder: an INR event with sensible defaults; id = sourceRef. */
export function ev(p: Partial<LedgerEvent> & Pick<LedgerEvent, "type" | "date" | "qty">): LedgerEvent {
  const sourceRef = p.sourceRef ?? p.id ?? `${p.source ?? "fill"}:${p.type}:${p.date}:${p.qty}:${p.price ?? 0}`;
  return {
    instrumentId: "INFY",
    price: 0,
    currency: "INR",
    fxRateInr: 1,
    source: "fill",
    approximate: false,
    ...p,
    id: p.id ?? sourceRef,
    sourceRef,
  };
}

export const snap = (runId: string, takenAt: string, qty: number, avgPrice: number): Snapshot => ({
  runId,
  takenAt,
  broker: "kite",
  instrumentId: "INFY",
  qty,
  avgPrice,
});
