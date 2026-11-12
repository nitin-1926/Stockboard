import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ExportKind } from "@/lib/export/sheets";

/** Header "Export" menu: plain download links to /api/export/<kind>, which redacts per actor. */
export function ExportMenu({ kind }: { kind: ExportKind }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="min-h-10 text-[13px] md:min-h-8">
          <DownloadIcon aria-hidden />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuItem asChild className="min-h-10 cursor-pointer px-2.5 md:min-h-8">
          <a href={`/api/export/${kind}?format=csv`} download>
            <FileTextIcon aria-hidden />
            CSV
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="min-h-10 cursor-pointer px-2.5 md:min-h-8">
          <a href={`/api/export/${kind}?format=xlsx`} download>
            <FileSpreadsheetIcon aria-hidden />
            Excel (.xlsx)
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
