import { Upload } from "lucide-react";
import type { ImportJobStatus } from "@/hooks/useImportJob";

interface Props {
  jobs: ImportJobStatus[];
  onOpen: (jobId: string) => void;
}

/** Pill-shaped status badge for the topbar. Polling/dialog mounting is
 *  hoisted to AppLayout so the indicator can be rendered twice (mobile +
 *  desktop) without doubling the network rate.
 *
 *  The summary shown here is intentionally pessimistic — when total_files
 *  is still 0 (server hasn't finalized any upload yet), we either show
 *  the source label or a "Preparing…" hint instead of a fake 0%, so the
 *  user knows something is happening even before the processing phase. */
export function ImportIndicator({ jobs, onOpen }: Props) {
  if (jobs.length === 0) return null;

  // Most recent active job drives the pill. Multi-job badge could come
  // later, but in practice users start one import at a time.
  const job = jobs[0];
  const label = pillLabel(job);

  return (
    <button
      onClick={() => onOpen(job.job_id)}
      className="flex items-center gap-2 rounded-full bg-primary/10 hover:bg-primary/20 transition px-3 py-1 text-xs font-medium max-w-[24rem]"
      title={job.source_label || "Import in progress — click to view"}
    >
      <Upload className="h-3.5 w-3.5 shrink-0" />
      <span className="tabular-nums truncate">{label}</span>
    </button>
  );
}

function pillLabel(job: ImportJobStatus): string {
  // Server-side processing has started — show files done / total.
  if (job.total_files > 0) {
    const pct = Math.round(((job.processed + job.failed) / job.total_files) * 100);
    return `Import ${job.processed + job.failed}/${job.total_files} (${pct}%)`;
  }
  // Still in upload/queued phase. Surface the source label if we have
  // one — that tells the user *which* import is running, even if the
  // server hasn't started counting files yet.
  if (job.source_label) return `Import · ${job.source_label}`;
  return "Import · preparing…";
}
