import { Upload, ChevronDown } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ImportJobStatus } from "@/hooks/useImportJob";

interface Props {
  jobs: ImportJobStatus[];
  onOpen: (jobId: string) => void;
}

/** Pill-shaped status badge for the topbar. With multiple concurrent
 *  imports running, the pill becomes a dropdown so the user can pick
 *  which one to inspect. The single-job case stays a one-click pill.
 *
 *  Hoisted polling: this component never polls itself — AppLayout
 *  passes shared `jobs` so mounting twice (mobile + desktop slots)
 *  doesn't double the network rate. */
export function ImportIndicator({ jobs, onOpen }: Props) {
  if (jobs.length === 0) return null;

  if (jobs.length === 1) {
    const j = jobs[0];
    return (
      <button
        onClick={() => onOpen(j.job_id)}
        className="flex items-center gap-2 rounded-full bg-primary/10 hover:bg-primary/20 transition px-3 py-1 text-xs font-medium max-w-[24rem]"
        title={j.source_label || "Import in progress — click to view"}
      >
        <Upload className="h-3.5 w-3.5 shrink-0" />
        <span className="tabular-nums truncate">{summary(j)}</span>
      </button>
    );
  }

  // Multi-job mode: count badge + per-job picker.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-full bg-primary/10 hover:bg-primary/20 transition px-3 py-1 text-xs font-medium"
          title="Imports in progress — click to choose"
        >
          <Upload className="h-3.5 w-3.5 shrink-0" />
          <span className="tabular-nums">{jobs.length} imports running</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[24rem]">
        <DropdownMenuLabel>Active imports</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {jobs.map((j) => (
          <DropdownMenuItem
            key={j.job_id}
            onClick={() => onOpen(j.job_id)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="text-xs font-medium truncate w-full">
              {j.source_label || j.job_id.slice(0, 12)}
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {summary(j)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function summary(job: ImportJobStatus): string {
  if (job.total_files > 0) {
    const pct = Math.round(((job.processed + job.failed) / job.total_files) * 100);
    return `${job.processed + job.failed}/${job.total_files} files (${pct}%)`;
  }
  if (job.source_label) return `Import · ${job.source_label}`;
  return "Import · preparing…";
}
