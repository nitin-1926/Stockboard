// Server-only view module (same pattern as watchlist.ts): getTargetsView() resolves the
// actor, loads, and hands everything to the pure buildTargetsView().
//
// Redaction: targets carry prices, dates and percentages only, so TARGET_POLICY is empty
// and a hide-amounts actor sees the same numbers (R4 keeps prices and %). What IS
// restricted is set_by for share-link viewers (anonymous): "Owner" / "Contributor".
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, holdingSnapshots, instruments, priceLatest, targets, watchItems } from "@/db/schema";
import { type Actor, can, requireActor } from "@/lib/auth/access";
import { type FieldPolicy, redactForActor } from "@/lib/auth/redact";
import { isoInMarket } from "@/lib/ledger/queries";
import { daysBetween } from "@/lib/returns/xirr";
import type { Currency, ISODate, Market } from "@/lib/returns/types";
import { daysToResolve, factorAfter, type Split, type TargetKind, type TargetStatus, upside } from "@/lib/targets/evaluate";
import { type KindScore, scorecards } from "@/lib/targets/scorecard";
import { latestSnapshotRunIds } from "./holdings";

export interface TargetInput {
  id: string;
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  currency: Currency;
  kind: TargetKind;
  price: number;
  inputMode: "abs" | "pct";
  pctValue: number | null;
  deadline: ISODate | null;
  setBy: string;
  priceAtSet: number;
  setAt: Date;
  status: TargetStatus;
  resolvedAt: ISODate | null;
  resolvedPrice: number | null;
  bestPrice: number | null;
  missPct: number | null;
  replacedBy: string | null;
  note: string | null;
  ltp: { price: number; asOf: Date } | null;
  /** The instrument's splits/bonuses (any date): `price` is raw on the set date, these rebase it to today's. */
  actions: Split[];
}

/** A symbol a new target can be set on (held or watched), with its current price. */
export interface InstrumentOption {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: Currency;
  price: number | null;
}

export interface TargetsInputs {
  targets: TargetInput[];
  instruments: InstrumentOption[];
  ownerEmail: string | null;
  now: Date;
}

export interface TargetRow {
  id: string;
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  currency: Currency;
  kind: TargetKind;
  /** Pending: the effective level on today's basis (stored ÷ splits/bonuses since set). Resolved: as stored. */
  price: number;
  /** The stored level when a later split/bonus moved it (pending only); null otherwise. */
  setPrice: number | null;
  inputMode: "abs" | "pct";
  pctValue: number | null;
  priceAtSet: number;
  setOn: ISODate;
  /** Email for signed-in actors; "Owner" / "Contributor" for share-link viewers. */
  setBy: string;
  deadline: ISODate | null;
  /** Days until the deadline (0 = today); null without one. */
  daysLeft: number | null;
  status: TargetStatus;
  resolvedAt: ISODate | null;
  resolvedPrice: number | null;
  daysToResolve: number | null;
  bestPrice: number | null;
  missPct: number | null;
  /** Edited: this row was cancelled and replaced by a newer target. */
  replaced: boolean;
  note: string | null;
  ltp: number | null;
  ltpAsOf: string | null;
  /** Live distance from the current price to the level (pending only). */
  distancePct: number | null;
  /** Pending and the actor may edit/cancel it (owner: all; contributor: own). */
  canEdit: boolean;
}

/** No amount fields: a target is a price, a date and percentages. Kept so the pattern holds if one is added. */
export const TARGET_POLICY = [] as const satisfies FieldPolicy<TargetRow>;

export interface ScorecardRow {
  /** Email, or "Owner" / "Contributor" (numbered when several) for share-link viewers. */
  label: string;
  target: KindScore;
  stop: KindScore;
}

export interface TargetsView {
  active: TargetRow[];
  history: TargetRow[];
  scorecard: ScorecardRow[];
  canCreate: boolean;
  canReevaluate: boolean;
  /** Symbols for "New target"; empty unless the actor may create. */
  instruments: InstrumentOption[];
}

export function authorLabel(email: string, actor: Actor, ownerEmail: string | null) {
  if (actor.via !== "share-link") return email;
  return ownerEmail && email === ownerEmail ? "Owner" : "Contributor";
}

function buildRow(t: TargetInput, actor: Actor, owner: string | null, now: Date): TargetRow {
  const today = isoInMarket(now, t.currency).slice(0, 10);
  const setOn = isoInMarket(t.setAt, t.currency).slice(0, 10);
  const pending = t.status === "pending";
  // Same rule as evaluate(): only actions with ex-date after the set date and up to today count.
  const price = pending ? t.price / factorAfter(setOn, t.actions, today) : t.price;
  return {
    id: t.id,
    instrumentId: t.instrumentId,
    symbol: t.symbol,
    name: t.name,
    exchange: t.exchange,
    market: t.market,
    currency: t.currency,
    kind: t.kind,
    price,
    setPrice: price !== t.price ? t.price : null,
    inputMode: t.inputMode,
    pctValue: t.pctValue,
    priceAtSet: t.priceAtSet,
    setOn,
    setBy: authorLabel(t.setBy, actor, owner),
    deadline: t.deadline,
    daysLeft: t.deadline && pending ? daysBetween(today, t.deadline) : null,
    status: t.status,
    resolvedAt: t.resolvedAt,
    resolvedPrice: t.resolvedPrice,
    daysToResolve: t.status === "cancelled" ? null : daysToResolve(setOn, t.resolvedAt),
    bestPrice: t.bestPrice,
    missPct: t.missPct,
    replaced: t.replacedBy != null,
    note: t.note,
    ltp: t.ltp?.price ?? null,
    ltpAsOf: t.ltp?.asOf.toISOString() ?? null,
    distancePct: pending ? upside(price, t.ltp?.price) : null,
    canEdit: pending && can(actor, "edit_own", { by: t.setBy }),
  };
}

/** Pure: inputs → DTO for the actor. Active: nearest first; history: newest first. */
export function buildTargetsView(inputs: TargetsInputs, actor: Actor): TargetsView {
  const owner = inputs.ownerEmail?.toLowerCase() ?? null;
  const rows = inputs.targets.map((t) => redactForActor(actor, buildRow(t, actor, owner, inputs.now), TARGET_POLICY));
  const active = rows
    .filter((r) => r.status === "pending")
    .sort((a, b) => Math.abs(a.distancePct ?? Infinity) - Math.abs(b.distancePct ?? Infinity) || a.symbol.localeCompare(b.symbol));
  const history = rows
    .filter((r) => r.status !== "pending")
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "") || a.symbol.localeCompare(b.symbol));

  const cards = scorecards(
    inputs.targets.map((t) => ({
      setBy: t.setBy,
      kind: t.kind,
      status: t.status,
      setOn: isoInMarket(t.setAt, t.currency).slice(0, 10),
      resolvedAt: t.resolvedAt,
      missPct: t.missPct,
    })),
  );
  // Share-link viewers: emails become roles; several contributors are numbered so their rows stay apart.
  const contributors = cards.filter((c) => authorLabel(c.setBy, actor, owner) === "Contributor").length;
  let n = 0;
  const scorecard = cards.map((c) => {
    let label = authorLabel(c.setBy, actor, owner);
    if (label === "Contributor" && contributors > 1) label = `Contributor ${++n}`;
    return { label, target: c.target, stop: c.stop };
  });

  return {
    active,
    history,
    scorecard,
    canCreate: can(actor, "suggest"),
    canReevaluate: can(actor, "manage"),
    instruments: can(actor, "suggest") ? inputs.instruments : [],
  };
}

/** Nearest pending levels per instrument: the lowest target and the highest stop (closest to the price). */
export type Marks = { target: number | null; stop: number | null; count: number };

export function nearestMarks(rows: { instrumentId: string; kind: TargetKind; price: number }[]): Map<string, Marks> {
  const out = new Map<string, Marks>();
  for (const r of rows) {
    const m = out.get(r.instrumentId) ?? { target: null, stop: null, count: 0 };
    m.count++;
    if (r.kind === "target") m.target = m.target == null ? r.price : Math.min(m.target, r.price);
    else m.stop = m.stop == null ? r.price : Math.max(m.stop, r.price);
    out.set(r.instrumentId, m);
  }
  return out;
}

const num = (s: string | null) => (s == null ? null : Number(s));

/** `instrumentId` narrows the targets to one symbol (the symbol page, U19). */
export async function loadTargetsInputs(now: Date, instrumentId?: string): Promise<TargetsInputs> {
  const runIds = await latestSnapshotRunIds();
  const [rows, options, acts] = await Promise.all([
    db
      .select({ t: targets, i: instruments, p: priceLatest })
      .from(targets)
      .innerJoin(instruments, eq(instruments.id, targets.instrumentId))
      .leftJoin(priceLatest, eq(priceLatest.instrumentId, targets.instrumentId))
      .where(instrumentId ? eq(targets.instrumentId, instrumentId) : undefined)
      .orderBy(desc(targets.setAt)),
    db
      .select({ i: instruments, p: priceLatest })
      .from(instruments)
      .leftJoin(priceLatest, eq(priceLatest.instrumentId, instruments.id))
      .where(
        and(
          eq(instruments.priceUnavailable, false),
          or(
            inArray(instruments.id, db.select({ id: watchItems.instrumentId }).from(watchItems).where(isNull(watchItems.archivedAt))),
            runIds.length
              ? inArray(
                  instruments.id,
                  db
                    .select({ id: holdingSnapshots.instrumentId })
                    .from(holdingSnapshots)
                    .where(and(inArray(holdingSnapshots.runId, runIds), sql`${holdingSnapshots.qty} > 0`)),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(instruments.brokerSymbol),
    db
      .select()
      .from(corporateActions)
      .where(
        instrumentId
          ? eq(corporateActions.instrumentId, instrumentId)
          : inArray(corporateActions.instrumentId, db.selectDistinct({ id: targets.instrumentId }).from(targets)),
      ),
  ]);
  const actionsOf = Map.groupBy(acts, (a) => a.instrumentId);
  return {
    now,
    ownerEmail: process.env.OWNER_EMAIL ?? null,
    instruments: options.map(({ i, p }) => ({
      id: i.id,
      symbol: i.brokerSymbol,
      name: i.name,
      exchange: i.exchange,
      currency: i.currency,
      price: num(p?.price ?? null),
    })),
    targets: rows.map(({ t, i, p }) => ({
      id: t.id,
      instrumentId: i.id,
      symbol: i.brokerSymbol,
      name: i.name,
      exchange: i.exchange,
      market: i.market,
      currency: i.currency,
      kind: t.kind,
      price: Number(t.price),
      inputMode: t.inputMode,
      pctValue: num(t.pctValue),
      deadline: t.deadline,
      setBy: t.setBy,
      priceAtSet: Number(t.priceAtSet),
      setAt: t.setAt,
      status: t.status,
      resolvedAt: t.resolvedAt,
      resolvedPrice: num(t.resolvedPrice),
      bestPrice: num(t.bestPrice),
      missPct: num(t.missPct),
      replacedBy: t.replacedBy,
      note: t.note,
      ltp: p && !i.priceUnavailable ? { price: Number(p.price), asOf: p.asOf } : null,
      actions: (actionsOf.get(i.id) ?? []).map((a) => ({ exDate: a.exDate, ratio: Number(a.numerator) / Number(a.denominator) })),
    })),
  };
}

export async function getTargetsView(): Promise<TargetsView> {
  const actor = await requireActor();
  return buildTargetsView(await loadTargetsInputs(new Date()), actor);
}

/**
 * Holdings / watchlist: nearest pending levels per instrument, and whether the actor may set targets.
 * Built from buildTargetsView's rows so the levels are split/bonus-adjusted exactly as on the Targets page.
 */
export async function getTargetMarks(): Promise<{ marks: Map<string, Marks>; canSet: boolean }> {
  const actor = await requireActor();
  // ponytail: loads history rows and the "New target" options too; add a pending-only loader if the targets table grows large.
  const view = buildTargetsView(await loadTargetsInputs(new Date()), actor);
  return { marks: nearestMarks(view.active), canSet: can(actor, "suggest") };
}
