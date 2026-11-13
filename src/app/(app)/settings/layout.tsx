import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "@/components/shell/nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <PageHeader title="Settings" />
        <SettingsTabs />
      </div>
      {children}
    </div>
  );
}
