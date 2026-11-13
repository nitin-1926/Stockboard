import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { Panel } from "@/components/panel";
import { can, requireActor } from "@/lib/auth/access";
import { OwnerOnly, SectionHeader } from "../owner-only";
import { ImportForm } from "./import-form";

async function Import() {
  const actor = await requireActor();
  if (!can(actor, "manage")) return <OwnerOnly />;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Panel aria-labelledby="console">
        <SectionHeader id="console" title="Zerodha tradebook" description="Console, Reports, Tradebook, equity segment, as CSV. Upload the full range." />
        <ImportForm kind="console" />
      </Panel>

      <Panel aria-labelledby="us">
        <SectionHeader
          id="us"
          title="US trade history"
          description={
            <>
              CSV with <code className="font-mono text-[11px]">date,symbol,side,quantity,price,order_id</code>, prices in USD.
            </>
          }
        />
        <ImportForm kind="us" />
      </Panel>

      <p className="text-xs text-faint">Imported trades replace estimates built from daily holdings. Re-importing a file changes nothing.</p>
    </div>
  );
}

export default function ImportPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Import />
    </Suspense>
  );
}
