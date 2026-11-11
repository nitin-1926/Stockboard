import { NextResponse } from "next/server";
import { can, getActor } from "@/lib/auth/access";
import { toCsv } from "@/lib/export/csv";
import { EXPORT_KINDS, type ExportKind, exportFilename, exportSheets } from "@/lib/export/sheets";
import { toXlsx } from "@/lib/export/xlsx";

const TYPE = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

// GET /api/export/<holdings|buckets|trades|ledger>?format=csv|xlsx. Proxy skips /api, so
// access is resolved here: getActor() (never requireActor(), whose redirect makes no sense
// for a download) → 401 JSON when signed out or the link is dead, 403 for a non-owner
// asking for the ledger. Reading cookies keeps the handler dynamic.
export async function GET(req: Request, ctx: RouteContext<"/api/export/[kind]">) {
  const { kind } = await ctx.params;
  const format = new URL(req.url).searchParams.get("format") ?? "csv";
  if (!(EXPORT_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: "Unknown export" }, { status: 404 });
  if (format !== "csv" && format !== "xlsx") return NextResponse.json({ error: "format must be csv or xlsx" }, { status: 400 });

  const actor = await getActor();
  if ("denied" in actor) return NextResponse.json({ error: actor.denied }, { status: 401 });
  if (kind === "ledger" && !can(actor, "manage")) return NextResponse.json({ error: "Owner only" }, { status: 403 });

  const now = new Date();
  const sheets = await exportSheets(kind as ExportKind, actor, now);
  // CSV is a single table: the first sheet (holdings' Summary is XLSX only).
  const body = format === "csv" ? toCsv(sheets[0]) : await toXlsx(sheets);
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": TYPE[format],
      "Content-Disposition": `attachment; filename="${exportFilename(kind as ExportKind, format, now)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
