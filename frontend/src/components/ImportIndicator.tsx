import { Upload } from "lucide-react";
import type { ImportJobStatus } from "@/hooks/useImportJob";

interface Props {
  jobs: ImportJobStatus[];
  onOpen: (jobId: string) => void;
}

/** Pill-shaped status badge for the topbar. Polling/dialog mounting is
 *  hoisted to AppLayout so the indicator can be rendered twice (mobile +
 *  desktop) without doubling the network rate. */
export function ImportIndicator({ jobs, onOpen }: Props) {
  if (jobs.length === 0) return null;

  // Prefer the most recent active job for the pill summary.
  const job = jobs[0];
  const pct = job.total_files > 0
    ? Math.round(((job.processed + job.failed) / job.total_files) * 100)
    : 0;

  return (
    <button
      onClick={() => onOpen(job.job_id)}
      className="flex items-center gap-2 rounded-full bg-primary/10 hover:bg-primary/20 transition px-3 py-1 text-xs font-medium"
      title="Import in progress — click to view"
    >
      <Upload className="h-3.5 w-3.5" />
      <span className="tabular-nums">
        Import {job.processed + job.failed}/{job.total_files} ({pct}%)
      </span>
    </button>
  );
}
