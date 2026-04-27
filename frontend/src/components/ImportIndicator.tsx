import { useState } from "react";
import { Upload } from "lucide-react";
import { useActiveImports } from "@/hooks/useActiveImports";
import { ImportDialog } from "./ImportDialog";

export function ImportIndicator() {
  const jobs = useActiveImports();
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  if (jobs.length === 0) return null;

  // Prefer the most recent active job for the pill summary.
  const job = jobs[0];
  const pct = job.total_files > 0
    ? Math.round(((job.processed + job.failed) / job.total_files) * 100)
    : 0;

  return (
    <>
      <button
        onClick={() => setOpenJobId(job.job_id)}
        className="flex items-center gap-2 rounded-full bg-primary/10 hover:bg-primary/20 transition px-3 py-1 text-xs font-medium"
        title="Import in progress — click to view"
      >
        <Upload className="h-3.5 w-3.5" />
        <span className="tabular-nums">
          Import {job.processed + job.failed}/{job.total_files} ({pct}%)
        </span>
      </button>
      {openJobId && (
        <ImportDialog
          open={true}
          onOpenChange={(o) => { if (!o) setOpenJobId(null); }}
          attachJobId={openJobId}
        />
      )}
    </>
  );
}
