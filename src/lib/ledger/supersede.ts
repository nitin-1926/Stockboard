import { dateRange } from "./csv-import";
import { EPS, liveEvents } from "./lots";
import type { LedgerEvent, Supersession } from "./types";
import { addDays } from "./types";

/** A fill covers an inferred event if executed at most this long before its snapshot. */
const FILL_WINDOW_MS = 5 * 86_400_000;
/** An imported trade covers an inferred event dated up to this many days later. */
const IMPORT_LOOKBACK_DAYS = 7;

const isTrade = (e: LedgerEvent) => e.type === "buy" || e.type === "sell";
const isBuy = (e: LedgerEvent) => e.type === "buy" || e.type === "opening";
const isImport = (e: LedgerEvent) => e.source === "csv" || e.source === "us_history";
const moment = (e: LedgerEvent) => Date.parse(e.executedAt ?? e.date);
/** `fill:<tradeId>` / `csv:<tradeId>` → `<instrument>:<tradeId>`. */
const tradeKey = (e: LedgerEvent) => `${e.instrumentId}:${e.sourceRef.slice(e.sourceRef.indexOf(":") + 1)}`;

export interface SupersessionPlan {
  /** Link rows: one superseded event may have many superseding events. */
  supersessions: Supersession[];
  /**
   * Superseded buy → every superseding buy. The DB layer copies bucket_members,
   * watch_items.linked_buy_event_id and journal refs onto each, so no
   * membership is orphaned.
   */
  refRemap: Map<string, string[]>;
  /** Inferred remainders for inferred events only partly covered by fills; insert before the links. */
  remainders: LedgerEvent[];
}

/**
 * A live manual correction whose chain (manual → … → manual) starts at an inferred
 * trade or a fill stands in for that origin, so authoritative data supersedes the
 * manual head: an inferred origin is matched on its date and snapshot time (rules 3/4),
 * a fill origin on its trade id (rule 1, the Console row is exchange-confirmed). Any
 * other event is returned as is (a correction of a CSV row or opening keeps manual > csv).
 */
function asOrigin(e: LedgerEvent, byId: Map<string, LedgerEvent>, pred: Map<string, string[]>): LedgerEvent {
  let o = e;
  while (o.source === "manual") {
    const p = pred.get(o.id);
    const up = p?.length === 1 ? byId.get(p[0]) : undefined;
    if (!up) return e;
    o = up;
  }
  if (o === e || o.type !== e.type || !isTrade(o)) return e;
  if (o.source === "inferred") return { ...e, source: "inferred", approximate: true, date: o.date, executedAt: o.executedAt };
  if (o.source === "fill") return { ...e, source: "fill", sourceRef: o.sourceRef };
  return e;
}

/**
 * Source precedence at ingest: manual > csv/us_history > fill > inferred/opening,
 * except that csv/us_history/fill > a manual correction of an inferred trade, and
 * the Console row for a trade id > a manual correction of that trade's fill.
 * Superseded events are kept, never deleted; replay skips them.
 * `prior` = existing supersession rows, so re-planning is a no-op.
 */
export function planSupersession(
  existing: LedgerEvent[],
  incoming: LedgerEvent[],
  prior: Supersession[] = [],
): SupersessionPlan {
  const byIdExisting = new Map(existing.map((e) => [e.id, e]));
  const pred = new Map<string, string[]>();
  for (const s of prior) pred.set(s.supersedingId, [...(pred.get(s.supersedingId) ?? []), s.supersededId]);
  const live = liveEvents(existing, prior).map((e) => asOrigin(e, byIdExisting, pred));
  const all = [...live, ...incoming];
  const supersessions: Supersession[] = [];
  const done = new Set<string>();
  const supersede = (old: LedgerEvent, by: LedgerEvent[]) => {
    if (done.has(old.id) || by.length === 0) return;
    done.add(old.id);
    for (const b of by) supersessions.push({ supersededId: old.id, supersedingId: b.id });
  };

  // 1. A Console CSV row and a Kite fill for the same trade: the CSV wins.
  const csvByTrade = new Map(all.filter((e) => e.source === "csv").map((e) => [tradeKey(e), e]));
  for (const f of all.filter((e) => e.source === "fill")) {
    const twin = csvByTrade.get(tradeKey(f));
    if (twin) supersede(f, [twin]);
  }

  // 2. Manual correction replaces same-type events on its date.
  for (const m of incoming.filter((e) => e.source === "manual"))
    for (const old of live)
      if (old.source !== "manual" && old.instrumentId === m.instrumentId && old.type === m.type && old.date === m.date)
        supersede(old, [m]);

  // 3. CSV / US history: authoritative over inferred trades in its date range;
  //    replaces the opening once it covers buys on or before the opening date.
  const imported = incoming.filter((e) => isImport(e) && isTrade(e));
  for (const id of new Set(imported.map((e) => e.instrumentId))) {
    const mine = imported.filter((e) => e.instrumentId === id);
    const range = dateRange(mine);
    if (!range) continue;
    for (const old of live) {
      if (old.instrumentId !== id) continue;
      if (old.source === "inferred" && isTrade(old) && old.date >= range.from && old.date <= range.to) {
        const near = mine.filter(
          (e) => e.type === old.type && e.date <= old.date && e.date >= addDays(old.date, -IMPORT_LOOKBACK_DAYS),
        );
        supersede(old, near.length ? near : mine);
      } else if (old.type === "opening") {
        supersede(old, mine.filter((e) => e.type === "buy" && e.date <= old.date));
      }
    }
  }

  // 4. Fills arriving after an inference: allocate fill qty to inferred events
  //    of the same side whose snapshot came after the fill (oldest first).
  const fills = incoming
    .filter((e) => e.source === "fill" && isTrade(e) && !done.has(e.id))
    .sort((a, b) => moment(a) - moment(b));
  const targets = live
    .filter((e) => e.source === "inferred" && isTrade(e) && !done.has(e.id))
    .sort((a, b) => moment(a) - moment(b));
  const left = new Map(targets.map((t) => [t.id, t.qty]));
  const coveredBy = new Map<string, LedgerEvent[]>();
  for (const f of fills) {
    let qty = f.qty;
    for (const t of targets) {
      const cap = left.get(t.id) ?? 0;
      if (qty <= EPS) break;
      if (cap <= EPS || t.instrumentId !== f.instrumentId || t.type !== f.type) continue;
      if (moment(f) > moment(t) || moment(f) < moment(t) - FILL_WINDOW_MS) continue;
      const take = Math.min(cap, qty);
      left.set(t.id, cap - take);
      qty -= take;
      coveredBy.set(t.id, [...(coveredBy.get(t.id) ?? []), f]);
    }
  }
  const remainders: LedgerEvent[] = [];
  for (const t of targets) {
    const by = coveredBy.get(t.id);
    if (!by) continue;
    const rest = left.get(t.id) ?? 0;
    if (rest > EPS) {
      const sourceRef = `${t.sourceRef}:rem`;
      remainders.push({ ...t, id: sourceRef, sourceRef, qty: rest });
    }
    supersede(t, rest > EPS ? [...by, remainders[remainders.length - 1]] : by);
  }

  const byId = new Map([...all, ...remainders].map((e) => [e.id, e]));
  const refRemap = new Map<string, string[]>();
  for (const s of supersessions) {
    const [old, nu] = [byId.get(s.supersededId), byId.get(s.supersedingId)];
    if (old && nu && isBuy(old) && isBuy(nu)) refRemap.set(old.id, [...(refRemap.get(old.id) ?? []), nu.id]);
  }
  return { supersessions, refRemap, remainders };
}
