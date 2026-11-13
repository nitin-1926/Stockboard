import { desc } from "drizzle-orm";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { Panel, Tag } from "@/components/panel";
import { db } from "@/db";
import { accessGrants, shareLinks } from "@/db/schema";
import { can, requireActor } from "@/lib/auth/access";
import { isActive } from "@/lib/auth/grants";
import { cn } from "@/lib/utils";
import { fmtDate, OwnerOnly, SectionHeader } from "../owner-only";
import { revokeGrant, revokeShareLink } from "./actions";
import { ConfirmSubmit, InviteDialog, MintLinkDialog } from "./forms";

type Lifetime = { expiresAt: Date | null; revokedAt: Date | null };

function StatusTag({ row, now }: { row: Lifetime; now: Date }) {
  if (row.revokedAt) return <Tag tone="sell">Revoked</Tag>;
  if (!isActive(row, now)) return <Tag>Expired</Tag>;
  return <Tag tone="buy">Active</Tag>;
}

const th = "h-9 px-4 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "h-12 px-4 whitespace-nowrap";
// First column stays put while the rest scrolls sideways on mobile.
const sticky = "max-md:sticky max-md:left-0 max-md:z-10 max-md:bg-card";

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="border-b">
          <tr>
            {head.map((h, i) => (
              <th key={h || i} scope="col" className={cn(th, i === 0 && sticky, !h && "text-right")}>
                {h || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="px-4 py-6 text-[13px] text-muted-foreground">{children}</p>;

async function Sharing() {
  const actor = await requireActor();
  if (!can(actor, "manage")) return <OwnerOnly />;

  const [grants, links] = await Promise.all([
    db.select().from(accessGrants).orderBy(desc(accessGrants.createdAt)),
    // Never select token_hash for the UI.
    db
      .select({
        id: shareLinks.id,
        label: shareLinks.label,
        hideAmounts: shareLinks.hideAmounts,
        expiresAt: shareLinks.expiresAt,
        revokedAt: shareLinks.revokedAt,
        lastUsedAt: shareLinks.lastUsedAt,
        createdAt: shareLinks.createdAt,
      })
      .from(shareLinks)
      .orderBy(desc(shareLinks.createdAt)),
  ]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <Panel aria-labelledby="people">
        <SectionHeader id="people" title="People" description="Google accounts that can sign in. Revoking applies on their next page load.">
          <InviteDialog />
        </SectionHeader>
        {grants.length === 0 ? (
          <Empty>No one is invited yet.</Empty>
        ) : (
          <Table head={["Email", "Role", "Amounts", "Expires", "Status", ""]}>
            {grants.map((g) => (
              <tr key={g.id} className={cn("hover:bg-muted/60", g.revokedAt && "text-muted-foreground")}>
                <td className={cn(td, sticky, "font-medium")}>{g.email}</td>
                <td className={td}>
                  <Tag tone={g.role === "contributor" ? "brand" : "neutral"} className="capitalize">
                    {g.role}
                  </Tag>
                </td>
                <td className={cn(td, "text-muted-foreground")}>{g.hideAmounts ? "Hidden" : "Shown"}</td>
                <td className={cn(td, "num")}>{fmtDate(g.expiresAt)}</td>
                <td className={td}>
                  <StatusTag row={g} now={now} />
                </td>
                <td className={cn(td, "text-right")}>
                  {!g.revokedAt && (
                    <form action={revokeGrant.bind(null, g.id)}>
                      <ConfirmSubmit message={`Revoke access for ${g.email}?`}>Revoke</ConfirmSubmit>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel aria-labelledby="links">
        <SectionHeader id="links" title="Share links" description="Anyone with a link gets a read-only view, no sign-in.">
          <MintLinkDialog />
        </SectionHeader>
        {links.length === 0 ? (
          <Empty>No share links yet.</Empty>
        ) : (
          <Table head={["Label", "Amounts", "Created", "Expires", "Last used", "Status", ""]}>
            {links.map((l) => (
              <tr key={l.id} className={cn("hover:bg-muted/60", l.revokedAt && "text-muted-foreground")}>
                <td className={cn(td, sticky, "font-medium")}>{l.label ?? <span className="text-faint">Untitled</span>}</td>
                <td className={cn(td, "text-muted-foreground")}>{l.hideAmounts ? "Hidden" : "Shown"}</td>
                <td className={cn(td, "num")}>{fmtDate(l.createdAt)}</td>
                <td className={cn(td, "num")}>{fmtDate(l.expiresAt)}</td>
                <td className={cn(td, "num")}>{l.lastUsedAt ? fmtDate(l.lastUsedAt) : <span className="text-faint">Not yet</span>}</td>
                <td className={td}>
                  <StatusTag row={l} now={now} />
                </td>
                <td className={cn(td, "text-right")}>
                  {!l.revokedAt && (
                    <form action={revokeShareLink.bind(null, l.id)}>
                      <ConfirmSubmit message={`Revoke the link "${l.label ?? "Untitled"}"? Anyone using it loses access.`}>
                        Revoke
                      </ConfirmSubmit>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

export default function SharingPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Sharing />
    </Suspense>
  );
}
