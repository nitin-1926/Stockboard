"use client";

import { CheckIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type PrefsResult, savePreferencesAction } from "./actions";

export type PrefsDefaults = {
  stockPct: number;
  sectorPct: number;
  inLargeCr: number;
  inMidCr: number;
  usLargeBn: number;
  usMidBn: number;
  indiaTdsPct: number;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden />}
      Save changes
    </Button>
  );
}

/** One setting: label + short description left, control right. Stacks on mobile. */
export function SettingRow({ htmlFor, label, description, error, inline, children }: { htmlFor: string; label: string; description?: string; error?: string; inline?: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8", inline ? "items-center justify-between" : "flex-col")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
        </label>
        {description && (
          <p id={`${htmlFor}-desc`} className="text-xs text-muted-foreground">
            {description}
          </p>
        )}
        {error && (
          <p id={`${htmlFor}-err`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel>
      <h2 className="border-b px-4 py-3 text-sm font-semibold">{title}</h2>
      <div className="divide-y">{children}</div>
    </Panel>
  );
}

function Num({ name, label, unit, description, value, error }: { name: keyof PrefsDefaults; label: string; unit: string; description?: string; value: number; error?: string }) {
  const describedBy = [description && `${name}-desc`, error && `${name}-err`].filter(Boolean).join(" ") || undefined;
  return (
    <SettingRow htmlFor={name} label={label} description={description} error={error}>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id={name}
          name={name}
          type="number"
          inputMode="decimal"
          step="any"
          min="0"
          required
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="num h-9 w-28 text-right md:h-8"
        />
        <span className="w-14 text-xs text-muted-foreground">{unit}</span>
      </div>
    </SettingRow>
  );
}

export function PreferencesForm({ defaults }: { defaults: PrefsDefaults }) {
  const [state, action] = useActionState<PrefsResult, FormData>(savePreferencesAction, null);
  const err = (f: keyof PrefsDefaults) => (state && "error" in state && state.field === f ? state.error : undefined);
  return (
    <form action={action} className="flex flex-col gap-6">
      <SettingsGroup title="Concentration limits">
        <Num name="stockPct" label="Single stock" description="Warn when one holding is above this share of the portfolio" unit="%" value={defaults.stockPct} error={err("stockPct")} />
        <Num name="sectorPct" label="Sector" description="Warn when one sector is above this share" unit="%" value={defaults.sectorPct} error={err("sectorPct")} />
      </SettingsGroup>

      <SettingsGroup title="Company size">
        <Num name="inLargeCr" label="India large cap from" description="Approximates SEBI's top 100" unit="₹ crore" value={defaults.inLargeCr} error={err("inLargeCr")} />
        <Num name="inMidCr" label="India mid cap from" description="Approximates SEBI's top 250, smaller is small cap" unit="₹ crore" value={defaults.inMidCr} />
        <Num name="usLargeBn" label="US large cap from" unit="$ billion" value={defaults.usLargeBn} error={err("usLargeBn")} />
        <Num name="usMidBn" label="US mid cap from" description="Smaller is small cap" unit="$ billion" value={defaults.usMidBn} />
      </SettingsGroup>

      <SettingsGroup title="Dividends">
        <Num
          name="indiaTdsPct"
          label="India dividend TDS"
          description="Income and benchmarks are net of it, US uses the 25% treaty rate"
          unit="%"
          value={defaults.indiaTdsPct}
          error={err("indiaTdsPct")}
        />
      </SettingsGroup>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {state && "ok" in state && (
          <p role="status" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <CheckIcon className="size-4" aria-hidden />
            Saved
          </p>
        )}
        {state && "error" in state && !state.field && (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        )}
        <Submit />
      </div>
    </form>
  );
}
