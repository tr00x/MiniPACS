import { useCallback, useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useImportJob } from "@/hooks/useImportJob";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Files that started the flow (e.g. from a window-level drop). Optional. */
  initialFiles?: File[];
}

const ACCEPT =
  // Everything the backend can ingest. Browsers use this as a filter in the
  // file picker; drag-drop ignores it (by spec) so the backend is still the
  // authoritative gate.
  ".dcm,.dicom,.zip,.tar,.tgz,.tar.gz,.tbz2,.tar.bz2,.txz,.tar.xz,.7z,.iso,.img,application/dicom,application/zip,application/x-tar,application/x-7z-compressed";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function ImportDialog({ open, onOpenChange, initialFiles }: Props) {
  const { status, uploading, progressPct, error, submit, reset } = useImportJob();
  const [queued, setQueued] = useState<File[]>([]);
  const [dragInside, setDragInside] = useState(false);

  // If the parent opened us with pre-dropped files, seed the queue.
  useEffect(() => {
    if (open && initialFiles && initialFiles.length > 0) {
      setQueued(initialFiles);
    }
  }, [open, initialFiles]);

  // Clean up when the dialog closes.
  useEffect(() => {
    if (!open) {
      setQueued([]);
      setDragInside(false);
      reset();
    }
  }, [open, reset]);

  // Toast on terminal state so the user sees the result even after closing.
  useEffect(() => {
    if (!status) return;
    if (status.status === "done") {
      const ok = status.processed;
      const fail = status.failed;
      const studies = status.studies_created;
      toast.success(
        `Import complete: ${ok} instance${ok === 1 ? "" : "s"}, ${studies} ${studies === 1 ? "study" : "studies"}` +
        (fail ? ` · ${fail} failed` : ""),
      );
    } else if (status.status === "error") {
      toast.error(`Import failed: ${status.errors.slice(-1)[0] || "unknown error"}`);
    }
  }, [status?.status]); // eslint-disable-line react-hooks/exhaustive-deps

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
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        files.push(e.dataTransfer.files[i]);
      }
    }
    if (files.length) setQueued((prev) => [...prev, ...files]);
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const arr: File[] = [];
    for (let i = 0; i < e.target.files.length; i++) arr.push(e.target.files[i]);
    setQueued((prev) => [...prev, ...arr]);
    // reset input so the same file can be re-picked
    e.target.value = "";
  };

  const start = async () => {
    if (queued.length === 0) return;
    await submit(queued);
  };

  const totalBytes = queued.reduce((a, f) => a + f.size, 0);
  const inProgress = !!status && status.status !== "done" && status.status !== "error";
  const terminal = !!status && (status.status === "done" || status.status === "error");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import studies</DialogTitle>
          <DialogDescription>
            Drop DICOM files, archives (ZIP / TAR / 7Z) or ISO images into the
            area below. Whole folders work too. Files go straight into the
            PACS via Orthanc.
          </DialogDescription>
        </DialogHeader>

        {!status && (
          <div
            onDragEnter={(e) => { e.preventDefault(); setDragInside(true); }}
            onDragOver={(e) => { e.preventDefault(); setDragInside(true); }}
            onDragLeave={() => setDragInside(false)}
            onDrop={onDrop}
            className={[
              "rounded-lg border-2 border-dashed transition-colors px-6 py-10 text-center",
              dragInside
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/30 bg-muted/20",
            ].join(" ")}
          >
            <div className="text-lg font-medium mb-2">
              {dragInside ? "Drop files here" : "Drag files or folders"}
            </div>
            <div className="text-sm text-muted-foreground mb-4">
              DICOM · ZIP · TAR · 7Z · ISO · whole folders
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button asChild variant="outline">
                    <label className="cursor-pointer">
                      Choose files
                      <input
                        type="file"
                        className="hidden"
                        multiple
                        accept={ACCEPT}
                        onChange={onPick}
                      />
                    </label>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Drop hundreds of files at once — extraction happens server-side
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="text-xs text-muted-foreground mt-4">
              Upload cap: 20 GB per job. For larger archives use{" "}
              <code>scripts/import_archive.py</code>.
            </div>
          </div>
        )}

        {queued.length > 0 && !status && (
          <div className="border rounded-md">
            <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium flex justify-between">
              <span>Queued: {queued.length} file{queued.length === 1 ? "" : "s"}, {formatBytes(totalBytes)}</span>
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
                  <span className="text-muted-foreground">{formatBytes(f.size)}</span>
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

        {status && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium capitalize">
                {status.status === "queued" && "Queued..."}
                {status.status === "extracting" && "Extracting archive..."}
                {status.status === "uploading" && "Uploading to Orthanc..."}
                {status.status === "done" && "Done"}
                {status.status === "error" && "Error"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {status.total_files > 0
                  ? `${status.processed + status.failed} / ${status.total_files}`
                  : ""}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={[
                  "h-full transition-all duration-300",
                  status.status === "error" ? "bg-destructive" : "bg-primary",
                ].join(" ")}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {status.current_file && !terminal && (
              <div className="text-xs text-muted-foreground truncate">
                Current file: {status.current_file}
              </div>
            )}
            {terminal && (
              <div className="text-sm grid grid-cols-3 gap-2">
                <div className="border rounded p-2 text-center">
                  <div className="text-xs text-muted-foreground">Uploaded</div>
                  <div className="text-lg font-medium">{status.processed}</div>
                </div>
                <div className="border rounded p-2 text-center">
                  <div className="text-xs text-muted-foreground">Studies</div>
                  <div className="text-lg font-medium">{status.studies_created}</div>
                </div>
                <div className="border rounded p-2 text-center">
                  <div className="text-xs text-muted-foreground">Failed</div>
                  <div className={`text-lg font-medium ${status.failed ? "text-destructive" : ""}`}>
                    {status.failed}
                  </div>
                </div>
              </div>
            )}
            {status.errors.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Show errors ({status.errors.length})
                </summary>
                <div className="mt-2 border rounded p-2 max-h-32 overflow-auto font-mono">
                  {status.errors.map((e, i) => (
                    <div key={i} className="truncate">{e}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded p-2">
            {error}
          </div>
        )}

        <DialogFooter>
          {!status ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={queued.length === 0 || uploading} onClick={start}>
                {uploading ? "Uploading..." : `Import (${queued.length})`}
              </Button>
            </>
          ) : (
            <Button
              variant={terminal ? "default" : "outline"}
              disabled={inProgress}
              onClick={() => onOpenChange(false)}
            >
              {inProgress ? "In progress..." : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
