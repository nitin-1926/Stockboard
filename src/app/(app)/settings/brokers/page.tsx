import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { Panel, PanelHeader, Tag } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { can, requireActor } from "@/lib/auth/access";
import {
  type ConnectionStatus,
  getConnection,
  kiteCredentialsReadable,
  publicConnectionView,
} from "@/lib/brokers/connections";
import { isRunning, lastRun } from "@/lib/jobs/handler";
import { Fact, Faint, fmtDate, OwnerOnly } from "../owner-only";
import { KiteCredentials } from "./kite-form";
import { KiteLoginButton, KiteSyncButton } from "./kite-login-button";

type View = ReturnType<typeof publicConnectionView>;

const fmtDateTime = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : null;

const STEP_HINT: Record<string, string> = {
  authorize_app: "Kite wants a one-time app approval. Use Reconnect Kite once.",
  twofa: "Check the TOTP secret. The daily job does not retry, to avoid locking the account.",
  login: "Check the Kite user ID and password.",
  session: "The Kite session ended (it expires at 06:00 IST). The next daily login renews it.",
};

// sync_runs counts of a kite-sync run shown to the owner (src/lib/jobs/kite-sync.ts).
const SYNC_COUNTS: [key: string, label: string][] = [
  ["snapshots", "holdings"],
  ["fills_new", "new trades"],
  ["openings", "openings"],
  ["inferred", "inferred trades"],
  ["review", "for review"],
];

const RUN_LABEL: Record<string, string> = { running: "Running", completed: "Completed", failed: "Failed" };

const STATUS: Record<ConnectionStatus["status"], { label: string; tone: "neutral" | "buy" | "sell" | "brand" }> = {
  disconnected: { label: "Not connected", tone: "neutral" },
  connected: { label: "Connected", tone: "buy" },
  stale: { label: "Expired", tone: "brand" },
  login_failed: { label: "Login failed", tone: "sell" },
  needs_consent: { label: "Needs consent", tone: "brand" },
};

const NOTICE: Record<string, string> = {
  connected: "Kite connected.",
  failed: "Kite connection failed at the token exchange. Try Reconnect Kite again.",
};

function StatusTag({ view }: { view: View }) {
  const s = STATUS[view.status];
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

function LastRun({ run }: { run: Awaited<ReturnType<typeof lastRun>> }) {
  if (!run) return <Faint>Never</Faint>;
  const counts = run.status === "completed" ? SYNC_COUNTS.filter(([k]) => Number(run.counts[k]) > 0).map(([k, l]) => `${run.counts[k]} ${l}`) : [];
  return (
    <>
      <span className={run.status === "failed" ? "text-loss" : undefined}>{RUN_LABEL[run.status] ?? run.status}</span>
      <span className="block text-xs whitespace-nowrap text-muted-foreground">{fmtDateTime(run.finishedAt ?? run.startedAt)}</span>
      {counts.length > 0 && <span className="block text-xs text-faint">{counts.join(", ")}</span>}
    </>
  );
}

function Credentials({ view, readable }: { view: View; readable: boolean }) {
  if (!view.credentialsSet) return <Faint>Not set</Faint>;
  if (!readable) return <span className="text-loss">Re-enter needed</span>;
  return (
    <>
      Saved <span className="text-muted-foreground">{fmtDate(view.credentialsUpdatedAt, "")}</span>
    </>
  );
}

/** Failed step + what to do about it. Quiet: the status tag already carries the alarm. */
function StepHint({ view }: { view: View }) {
  if (!view.lastErrorStep) return null;
  return (
    <p className="border-t px-4 py-3 text-[13px] text-muted-foreground">
      <span className="text-foreground">Failed at step {view.lastErrorStep}.</span> {STEP_HINT[view.lastErrorStep] ?? ""}
    </p>
  );
}

async function Brokers({ searchParams }: { searchParams: PageProps<"/settings/brokers">["searchParams"] }) {
  const actor = await requireActor();
  if (!can(actor, "manage")) return <OwnerOnly />;
  const [kiteRow, indmoneyRow, loginRunning, syncRunning, credentialsReadable, sync] = await Promise.all([
    getConnection("kite"),
    getConnection("indmoney"),
    isRunning("kite-login"),
    isRunning("kite-sync"),
    kiteCredentialsReadable(),
    lastRun("kite-sync"),
  ]);
  const [kite, indmoney] = [kiteRow, indmoneyRow].map(publicConnectionView);
  const k = (await searchParams).kite;
  const notice = typeof k === "string" && Object.hasOwn(NOTICE, k) ? NOTICE[k] : null;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {notice && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {notice}
        </p>
      )}

      <Panel aria-labelledby="kite">
        <PanelHeader id="kite" title="Zerodha Kite">
          <StatusTag view={kite} />
        </PanelHeader>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 lg:grid-cols-4">
          <Fact label="Token expires">{fmtDateTime(kite.tokenExpiresAt) ?? <Faint />}</Fact>
          <Fact label="Last sync">{kite.lastSyncAt ? fmtDate(kite.lastSyncAt) : <Faint>Never</Faint>}</Fact>
          <Fact label="Last run">
            <LastRun run={sync} />
          </Fact>
          <Fact label="Credentials">
            <Credentials view={kite} readable={credentialsReadable} />
          </Fact>
        </dl>
        <StepHint view={kite} />
        <KiteCredentials credentialsSet={kite.credentialsSet}>
          {/* Owner logs in to Kite in this browser; the daily job uses the saved credentials. */}
          <form action="/api/connect/kite" method="post">
            <Button type="submit" variant="outline">
              {kite.status === "disconnected" ? "Connect Kite" : "Reconnect Kite"}
            </Button>
          </form>
          {/* Runs the daily `kite-login` job now, from this server, with the saved credentials. */}
          <KiteLoginButton running={loginRunning} canRun={credentialsReadable} />
          {/* Syncs with the stored session; re-logs in once if it has expired. */}
          <KiteSyncButton running={syncRunning || loginRunning} canRun={credentialsReadable || kite.status === "connected"} />
        </KiteCredentials>
      </Panel>

      <Panel aria-labelledby="indmoney">
        <PanelHeader id="indmoney" title="INDmoney">
          <StatusTag view={indmoney} />
        </PanelHeader>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 lg:grid-cols-4">
          <Fact label="Token expires">{fmtDateTime(indmoney.tokenExpiresAt) ?? <Faint />}</Fact>
          <Fact label="Last sync">{indmoney.lastSyncAt ? fmtDate(indmoney.lastSyncAt) : <Faint>Never</Faint>}</Fact>
        </dl>
        <StepHint view={indmoney} />
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <span className="text-xs text-faint">Coming soon</span>
          {/* Wired in U6 (MCP OAuth consent). */}
          <Button variant="outline" disabled>
            Connect
          </Button>
        </div>
      </Panel>
    </div>
  );
}

export default function BrokersPage({ searchParams }: PageProps<"/settings/brokers">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Brokers searchParams={searchParams} />
    </Suspense>
  );
}
