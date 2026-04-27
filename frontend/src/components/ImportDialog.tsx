import { useCallback, useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useImportJob, isTerminal, type FileError } from "@/hooks/useImportJob";
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

/** Compact label for the job-source line: "cd2.iso, cd3.iso · 4.7 GB". */
function buildSourceLabel(files: File[]): string {
  if (files.length === 0) return "";
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const names = files.length <= 3
    ? files.map((f) => f.name).join(", ")
    : `${files.slice(0, 2).map((f) => f.name).join(", ")} + ${files.length - 2} more`;
  return `${names} · ${fmtBytes(totalBytes)}`;
}

export function ImportDialog({ open, onOpenChange, initialFiles, attachJobId }: Props) {
  const job = useImportJob();
  const upload = useChunkedUpload();
  const [queued, setQueued] = useState<File[]>([]);
  const [dragInside, setDragInside] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Attach mode: pre-existing job from ImportIndicator click.
  useEffect(() => {
    if (open && attachJobId) job.attach(attachJobId);
    if (!open) {
      job.reset();
      upload.reset();
      setQueued([]);
      setDragInside(false);
      setConfirmCancel(false);
      setCancelling(false);
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
    } else if (job.status.status === "cancelled") {
      toast.info("Import cancelled");
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
    const sourceLabel = buildSourceLabel(queued);
    const jobId = await job.startJob(sourceLabel);
    await upload.start(queued, jobId);
  };

  const doCancel = async () => {
    if (!job.status) return;
    setCancelling(true);
    try {
      // Stop the local upload loop so it doesn't keep PUT-ing chunks
      // against a job that's about to be cleaned up server-side.
      upload.cancel();
      await job.cancel(job.status.job_id);
      setConfirmCancel(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Cancel failed: ${msg}`);
    } finally {
      setCancelling(false);
    }
  };

  const totalBytes = queued.reduce((a, f) => a + f.size, 0);
  const inProgress = !!job.status && !isTerminal(job.status.status);
  const terminal = !!job.status && isTerminal(job.status.status);
  const readOnly = !!attachJobId;

  // Real-time upload-phase totals from the backend.
  const up = job.uploads;
  const uploadActive = inProgress && up !== null && up.chunks_total > 0
    && up.chunks_received < up.chunks_total
    && job.status!.total_files === 0;

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => { if (!cancelling) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{readOnly ? "Import in progress" : "Import studies"}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "Tracking an active import. You can close this — progress is preserved."
              : "Drop DICOM files, archives (ZIP / TAR / 7Z) or ISO images. Whole folders work too. Files are stored directly in the PACS."}
          </DialogDescription>
        </DialogHeader>

        {/* Source label header — visible whenever we have a job (attach or fresh) */}
        {job.status?.source_label && (
          <div className="text-xs text-muted-foreground -mt-1 truncate">
            <span className="font-medium text-foreground/70">Source:</span> {job.status.source_label}
          </div>
        )}

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

        {/* Per-file upload progress (during local-driven upload phase) */}
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

        {/* Upload-phase progress (server-side aggregate of received chunks).
             Visible when attached to a running job, or while local upload
             hook hasn't finished but server has chunks staged. */}
        {uploadActive && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                Uploading… {up!.chunks_received}/{up!.chunks_total} chunks
              </span>
              <span className="text-muted-foreground tabular-nums">
                {fmtBytes(up!.bytes_received_est)} / {fmtBytes(up!.bytes_total)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${up!.chunks_total > 0 ? Math.round((up!.chunks_received / up!.chunks_total) * 100) : 0}%` }}
              />
            </div>
            {up!.files.length > 1 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Per-file ({up!.files.length})
                </summary>
                <div className="mt-2 border rounded p-2 max-h-32 overflow-auto">
                  {up!.files.map((f) => (
                    <div key={f.upload_id} className="flex justify-between font-mono">
                      <span className="truncate">{f.name}</span>
                      <span className="text-muted-foreground tabular-nums ml-2">
                        {f.received_chunks}/{f.total_chunks}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Server-side job state (after upload, during extract+store-in-PACS) */}
        {job.status && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium capitalize">
                {job.status.status === "queued" && (uploadActive ? "Receiving uploads…" : "Queued…")}
                {job.status.status === "extracting" && "Extracting archive…"}
                {job.status.status === "uploading" && "Storing in PACS…"}
                {job.status.status === "done" && "Done"}
                {job.status.status === "error" && "Error"}
                {job.status.status === "cancelled" && "Cancelled"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {job.status.total_files > 0
                  ? `${job.status.processed + job.status.failed} / ${job.status.total_files}`
                  : ""}
              </span>
            </div>
            {job.status.total_files > 0 && (
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={["h-full transition-all duration-300",
                    job.status.status === "error" ? "bg-destructive"
                    : job.status.status === "cancelled" ? "bg-muted-foreground/40"
                    : "bg-primary"].join(" ")}
                  style={{ width: `${job.progressPct}%` }}
                />
              </div>
            )}
            {job.status.current_file && !terminal && (
              <div className="text-xs text-muted-foreground truncate">
                Current file: {job.status.current_file}
              </div>
            )}
            {terminal && job.status.status !== "cancelled" && (
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
            {job.status.file_errors.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Show file errors ({job.status.file_errors.length})
                </summary>
                <div className="mt-2 border rounded p-2 max-h-32 overflow-auto">
                  {job.status.file_errors.map((fe: FileError, i) => (
                    <div key={i} className="flex justify-between gap-2 py-0.5 border-b last:border-b-0">
                      <span className="truncate font-mono">{fe.name}</span>
                      <span className="text-destructive truncate ml-2">{fe.reason}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {job.status.errors.length > 0 && job.status.file_errors.length === 0 && (
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

        <DialogFooter className="gap-2">
          {!job.status ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={queued.length === 0 || upload.uploading} onClick={start}>
                {upload.uploading ? "Uploading..." : `Import (${queued.length})`}
              </Button>
            </>
          ) : (
            <>
              {inProgress && (
                <Button
                  variant="destructive"
                  onClick={() => setConfirmCancel(true)}
                  disabled={cancelling}
                >
                  {cancelling ? "Cancelling…" : "Cancel import"}
                </Button>
              )}
              {job.status.status === "error" && job.status.upload_ids.length > 0 && (
                <Button variant="default" onClick={() => job.retry(job.status!.job_id)}>
                  Retry
                </Button>
              )}
              <Button
                variant={terminal ? "default" : "outline"}
                onClick={() => onOpenChange(false)}
                disabled={cancelling}
              >
                {inProgress ? "Hide (keeps running)" : "Close"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this import?</AlertDialogTitle>
          <AlertDialogDescription>
            Files already stored in PACS stay there. Anything still uploading
            will be discarded. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancelling}>Keep importing</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); doCancel(); }}
            disabled={cancelling}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {cancelling ? "Cancelling…" : "Yes, cancel"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
