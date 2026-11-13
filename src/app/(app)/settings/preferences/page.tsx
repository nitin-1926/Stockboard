import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { PaletteToggle } from "@/components/palette-toggle";
import { can, requireActor } from "@/lib/auth/access";
import { loadPreferences } from "@/lib/settings/preferences";
import { OwnerOnly } from "../owner-only";
import { PreferencesForm, SettingRow, SettingsGroup } from "./form";

async function Preferences() {
  const actor = await requireActor();
  if (!can(actor, "manage")) return <OwnerOnly />;
  const p = await loadPreferences();
  // Display units; the action converts back. Rounded so float noise never shows in an input.
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {/* Per browser, applied instantly; not part of the saved form below. */}
      <SettingsGroup title="Display">
        <SettingRow inline htmlFor="palette" label="Colorblind-safe colors" description="Gains in blue, losses in orange">
          <PaletteToggle id="palette" />
        </SettingRow>
      </SettingsGroup>
      <PreferencesForm
        defaults={{
          stockPct: p.stockPct,
          sectorPct: p.sectorPct,
          inLargeCr: r(p.capThresholds.IN.large / 1e7),
          inMidCr: r(p.capThresholds.IN.mid / 1e7),
          usLargeBn: r(p.capThresholds.US.large / 1e9),
          usMidBn: r(p.capThresholds.US.mid / 1e9),
          indiaTdsPct: r(p.indiaTds * 100),
        }}
      />
    </div>
  );
}

export default function PreferencesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Preferences />
    </Suspense>
  );
}
