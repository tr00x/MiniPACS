import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useImportJob, isTerminal, type FileError } from "@/hooks/useImportJob";
import {
  useImports, computeRate, computeEta, computeFileStats,
  type LocalUploadState,
} from "@/providers/ImportsProvider";
import { ImportPhaseTimeline } from "@/components/ImportPhaseTimeline";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

function fmtRate(bps: number): string {
  if (bps <= 0) return "—";
  const mbps = (bps * 8) / 1_000_000;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

function fmtEta(secs: number | null): string {
  if (secs === null) return "—";
  if (secs <= 1) return "<1s";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ImportDialog({ open, onOpenChange, attachJobId }: Props) {
  const job = useImportJob();
  const imports = useImports();

  // Local "compose mode" state — only used when this dialog opened
  // standalone (no attachJobId) to gather files for a fresh import.
  const [queued, setQueued] = useState<File[]>([]);
  const [dragInside, setDragInside] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [starting, setStarting] = useState(false);
  // Once we kick off an import from this dialog, switch to viewer mode
  // by remembering the job_id we created. Same effect as if the parent
  // had passed attachJobId.
  const [localAttachId, setLocalAttachId] = useState<string | null>(null);

  // Effective job id for viewer mode — either parent-supplied or
  // self-started.
  const viewerJobId = attachJobId ?? localAttachId;
  // Local upload progress slice (per-file bytes_sent, status, errors).
  const localUpload = viewerJobId ? imports.uploads[viewerJobId] : undefined;

  // Server-side polling.
  useEffect(() => {
    if (open && viewerJobId) job.attach(viewerJobId);
    if (!open) {
      job.reset();
      setQueued([]);
      setDragInside(false);
      setConfirmCancel(false);
      setCancelling(false);
      setStarting(false);
      setLocalAttachId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewerJobId]);

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
    setStarting(true);
    try {
      const jobId = await imports.start(queued, { silent: true });
      setLocalAttachId(jobId);  // re-attaches the dialog to the new job
      setQueued([]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to start import: ${msg}`);
    } finally {
      setStarting(false);
    }
  };

  const doCancel = async () => {
    if (!viewerJobId) return;
    setCancelling(true);
    try {
      await imports.cancelLocal(viewerJobId);
      setConfirmCancel(false);
    } finally {
      setCancelling(false);
    }
  };

  const inProgress = !!job.status && !isTerminal(job.status.status);
  const terminal = !!job.status && isTerminal(job.status.status);

  // Real-time chunk-receipt totals (server-side aggregate).
  const up = job.uploads;
  const uploadActive = inProgress && up !== null && up.chunks_total > 0
    && up.chunks_received < up.chunks_total
    && job.status!.total_files === 0;

  // Compose mode: no attached job and nothing started yet.
  const composeMode = !viewerJobId;

  const totalBytesQueued = queued.reduce((a, f) => a + f.size, 0);

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => { if (!cancelling) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{!composeMode ? "Import in progress" : "Import studies"}</DialogTitle>
          <DialogDescription>
            {!composeMode
              ? "Tracking an active import. You can close this — progress is preserved and other imports keep running."
              : "Drop DICOM files, archives (ZIP / TAR / 7Z) or ISO images. Whole folders work too. Multiple drops run in parallel."}
          </DialogDescription>
        </DialogHeader>

        {/* Source label header — visible whenever we have a job */}
        {job.status?.source_label && (
          <div className="text-xs text-muted-foreground -mt-1 truncate">
            <span className="font-medium text-foreground/70">Source:</span> {job.status.source_label}
          </div>
        )}

        {/* Phase timeline — what's running now AND what's coming next */}
        {job.status && (
          <ImportPhaseTimeline job={job.status} local={localUpload} />
        )}

        {composeMode && (
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

        {composeMode && queued.length > 0 && (
          <div className="border rounded-md">
            <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium flex justify-between">
              <span>Queued: {queued.length} file{queued.length === 1 ? "" : "s"}, {fmtBytes(totalBytesQueued)}</span>
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

        {/* Live throughput tiles — only meaningful while local upload is in flight */}
        {localUpload && localUpload.uploading && (
          <LiveTiles state={localUpload} />
        )}

        {/* Per-file local upload progress (client-driven phase) */}
        {localUpload && localUpload.files.length > 0 && (
          <div className="border rounded-md">
            <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium flex justify-between">
              <span>
                Uploading: {fmtBytes(localUpload.bytesSent)} / {fmtBytes(localUpload.totalBytes)}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {localUpload.totalBytes > 0
                  ? `${Math.round((localUpload.bytesSent / localUpload.totalBytes) * 100)}%`
                  : ""}
              </span>
            </div>
            <div className="max-h-40 overflow-auto text-sm">
              {localUpload.files.map((f, i) => (
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

        {/* Server-side aggregate chunk-receipt — shown when no local
             upload state (e.g. attached to a job started in another
             tab) but server confirms chunks are flowing in. */}
        {uploadActive && !localUpload && (
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
          </div>
        )}

        {/* Server-side job state (after upload, during extract+store-in-PACS) */}
        {job.status && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium capitalize">
                {job.status.status === "queued" && (uploadActive || localUpload?.uploading ? "Receiving uploads…" : "Queued…")}
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
          {composeMode ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={queued.length === 0 || starting} onClick={start}>
                {starting ? "Starting..." : `Import (${queued.length})`}
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
              {job.status?.status === "error" && job.status.upload_ids.length > 0 && (
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
            will be discarded. Other imports keep running. This cannot be undone.
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

/** Memoized live-throughput strip. Re-renders only when relevant
 *  fields of LocalUploadState change — keeps the heavier per-file
 *  list above from triggering on every chunk PUT. */
const LiveTiles = memo(function LiveTiles({ state }: { state: LocalUploadState }) {
  const stats = useMemo(() => computeFileStats(state), [state.files]);
  // Rate / ETA depend on samples, not files — separate memo so a
  // pure samples push doesn't recompute file counters.
  const rate = useMemo(() => computeRate(state), [state.samples]);
  const eta = useMemo(
    () => computeEta(state),
    [state.samples, state.bytesSent, state.totalBytes],
  );
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      <Tile label="Speed" value={fmtRate(rate)} />
      <Tile label="ETA" value={fmtEta(eta)} />
      <Tile label="Skipped (dup)" value={stats.skipped} />
      <Tile label="In flight" value={stats.uploading + stats.finalizing} />
    </div>
  );
});

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border rounded p-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}
