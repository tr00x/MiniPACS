import { useCallback, useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useImportJob } from "@/hooks/useImportJob";
import { useChunkedUpload } from "@/hooks/useChunkedUpload";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFiles?: File[];
  /** When set, dialog opens read-only attached to an existing job (used by ImportIndicator click). */
  attachJobId?: string;
}

const ACCEPT =
  ".dcm,.dicom,.zip,.tar,.tgz,.tar.gz,.tbz2,.tar.bz2,.txz,.tar.xz,.7z,.iso,.img," +
  "application/dicom,application/zip,application/x-tar,application/x-7z-compressed";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function ImportDialog({ open, onOpenChange, initialFiles, attachJobId }: Props) {
  const job = useImportJob();
  const upload = useChunkedUpload();
  const [queued, setQueued] = useState<File[]>([]);
  const [dragInside, setDragInside] = useState(false);

  // Attach mode: pre-existing job from ImportIndicator click.
  useEffect(() => {
    if (open && attachJobId) job.attach(attachJobId);
    if (!open) {
      job.reset();
      upload.reset();
      setQueued([]);
      setDragInside(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attachJobId]);

  useEffect(() => {
    if (open && initialFiles && initialFiles.length > 0 && !attachJobId) {
      setQueued(initialFiles);
    }
  }, [open, initialFiles, attachJobId]);

  // Toast on terminal state.
  useEffect(() => {
    if (!job.status) return;
    if (job.status.status === "done") {
      toast.success(
        `Import complete: ${job.status.new_instances} new, ${job.status.duplicate_instances} duplicates, ${job.status.studies_created} ${job.status.studies_created === 1 ? "study" : "studies"}` +
        (job.status.failed ? ` · ${job.status.failed} failed` : ""),
      );
    } else if (job.status.status === "error") {
      toast.error(`Import failed: ${job.status.errors.slice(-1)[0] || "unknown error"}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status?.status]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragInside(false);
    const files: File[] = [];
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const entry = items[i];
        if (entry.kind === "file") {
          const f = entry.getAsFile();
          if (f) files.push(f);
        }
      }
    } else {
      for (let i = 0; i < e.dataTransfer.files.length; i++) files.push(e.dataTransfer.files[i]);
    }
    if (files.length) setQueued((prev) => [...prev, ...files]);
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const arr: File[] = [];
    for (let i = 0; i < e.target.files.length; i++) arr.push(e.target.files[i]);
    setQueued((prev) => [...prev, ...arr]);
    e.target.value = "";
  };

  const start = async () => {
    if (queued.length === 0) return;
    const jobId = await job.startJob();
    await upload.start(queued, jobId);
  };

  const totalBytes = queued.reduce((a, f) => a + f.size, 0);
  const inProgress = !!job.status && job.status.status !== "done" && job.status.status !== "error";
  const terminal = !!job.status && (job.status.status === "done" || job.status.status === "error");
  const readOnly = !!attachJobId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{readOnly ? "Import in progress" : "Import studies"}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "Tracking an active import. You can close this — progress is preserved."
              : "Drop DICOM files, archives (ZIP / TAR / 7Z) or ISO images. Whole folders work too. Files go straight into the PACS via Orthanc."}
          </DialogDescription>
        </DialogHeader>

        {!job.status && !readOnly && (
          <div
            onDragEnter={(e) => { e.preventDefault(); setDragInside(true); }}
            onDragOver={(e) => { e.preventDefault(); setDragInside(true); }}
            onDragLeave={() => setDragInside(false)}
            onDrop={onDrop}
            className={[
              "rounded-lg border-2 border-dashed transition-colors px-6 py-10 text-center",
              dragInside ? "border-primary bg-primary/5" : "border-muted-foreground/30 bg-muted/20",
            ].join(" ")}
          >
            <div className="text-lg font-medium mb-2">
              {dragInside ? "Drop files here" : "Drag files or folders"}
            </div>
            <div className="text-sm text-muted-foreground mb-4">
              DICOM · ZIP · TAR · 7Z · ISO · whole folders
            </div>
            <Button asChild variant="outline">
              <label className="cursor-pointer">
                Choose files
                <input type="file" className="hidden" multiple accept={ACCEPT} onChange={onPick} />
              </label>
            </Button>
            <div className="text-xs text-muted-foreground mt-4">
              Files are checked for duplicates before upload. Resumes after dropped connections. 20 GB job cap.
            </div>
          </div>
        )}

        {queued.length > 0 && !job.status && (
          <div className="border rounded-md">
            <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium flex justify-between">
              <span>Queued: {queued.length} file{queued.length === 1 ? "" : "s"}, {fmtBytes(totalBytes)}</span>
              <button
                className="text-muted-foreground hover:text-foreground text-xs"
                onClick={() => setQueued([])}
              >
                Clear
              </button>
            </div>
            <div className="max-h-40 overflow-auto text-sm">
              {queued.slice(0, 50).map((f, i) => (
                <div key={i} className="px-3 py-1.5 border-b last:border-b-0 flex justify-between">
                  <span className="truncate">{f.name}</span>
                  <span className="text-muted-foreground">{fmtBytes(f.size)}</span>
                </div>
              ))}
              {queued.length > 50 && (
                <div className="px-3 py-1.5 text-center text-muted-foreground">
                  … and {queued.length - 50} more
                </div>
              )}
            </div>
          </div>
        )}

        {/* Per-file upload progress (during upload phase) */}
        {upload.files.length > 0 && !readOnly && (
          <div className="border rounded-md">
            <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium flex justify-between">
              <span>Uploading: {fmtBytes(upload.bytesSent)} / {fmtBytes(upload.totalBytes)}</span>
              <span className="text-muted-foreground tabular-nums">
                {upload.totalBytes > 0
                  ? `${Math.round((upload.bytesSent / upload.totalBytes) * 100)}%`
                  : ""}
              </span>
            </div>
            <div className="max-h-40 overflow-auto text-sm">
              {upload.files.map((f, i) => (
                <div key={i} className="px-3 py-1.5 border-b last:border-b-0 flex justify-between">
                  <span className="truncate flex-1">
                    {f.name}
                    {f.status === "skipped" && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (already in PACS — {f.duplicate_instances} instances)
                      </span>
                    )}
                    {f.status === "error" && (
                      <span className="ml-2 text-xs text-destructive">{f.error}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground capitalize">{f.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Server-side job state (after upload, during extract+upload-to-Orthanc) */}
        {job.status && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium capitalize">
                {job.status.status === "queued" && "Queued..."}
                {job.status.status === "extracting" && "Extracting archive..."}
                {job.status.status === "uploading" && "Uploading to Orthanc..."}
                {job.status.status === "done" && "Done"}
                {job.status.status === "error" && "Error"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {job.status.total_files > 0
                  ? `${job.status.processed + job.status.failed} / ${job.status.total_files}`
                  : ""}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={["h-full transition-all duration-300",
                  job.status.status === "error" ? "bg-destructive" : "bg-primary"].join(" ")}
                style={{ width: `${job.progressPct}%` }}
              />
            </div>
            {job.status.current_file && !terminal && (
              <div className="text-xs text-muted-foreground truncate">
                Current file: {job.status.current_file}
              </div>
            )}
            {terminal && (
              <div className="text-sm grid grid-cols-3 gap-2">
                <div className="border rounded p-2 text-center">
                  <div className="text-xs text-muted-foreground">New instances</div>
                  <div className="text-lg font-medium">{job.status.new_instances}</div>
                </div>
                <div className="border rounded p-2 text-center">
                  <div className="text-xs text-muted-foreground">Already in PACS</div>
                  <div className="text-lg font-medium">{job.status.duplicate_instances}</div>
                </div>
                <div className="border rounded p-2 text-center">
                  <div className="text-xs text-muted-foreground">Failed</div>
                  <div className={`text-lg font-medium ${job.status.failed ? "text-destructive" : ""}`}>
                    {job.status.failed}
                  </div>
                </div>
              </div>
            )}
            {job.status.errors.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Show errors ({job.status.errors.length})
                </summary>
                <div className="mt-2 border rounded p-2 max-h-32 overflow-auto font-mono">
                  {job.status.errors.map((e, i) => (
                    <div key={i} className="truncate">{e}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {job.error && (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded p-2">
            {job.error}
          </div>
        )}

        <DialogFooter>
          {!job.status ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={queued.length === 0 || upload.uploading} onClick={start}>
                {upload.uploading ? "Uploading..." : `Import (${queued.length})`}
              </Button>
            </>
          ) : (
            <>
              {job.status.status === "error" && job.status.upload_ids.length > 0 && (
                <Button variant="default" onClick={() => job.retry(job.status!.job_id)}>
                  Retry
                </Button>
              )}
              <Button
                variant={terminal ? "default" : "outline"}
                onClick={() => onOpenChange(false)}
              >
                {inProgress ? "Hide (keeps running)" : "Close"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
