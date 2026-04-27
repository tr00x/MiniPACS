import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ChevronLeft, ChevronRight, RefreshCw, FileX, FileCheck, Loader2 } from "lucide-react";
import { TableSkeleton } from "@/components/TableSkeleton";
import api from "@/lib/api";
import { ImportDialog } from "@/components/ImportDialog";
import type { ImportJobStatus, FileError } from "@/hooks/useImportJob";
import { isTerminal } from "@/hooks/useImportJob";

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "terminal", label: "Finished" },
  { value: "done", label: "Done" },
  { value: "error", label: "Error" },
  { value: "cancelled", label: "Cancelled" },
];

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTimestamp(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function StatusBadge({ status }: { status: ImportJobStatus["status"] }) {
  const styles: Record<typeof status, string> = {
    queued: "bg-muted text-foreground/70",
    extracting: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    uploading: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    error: "bg-destructive/10 text-destructive",
    cancelled: "bg-muted text-muted-foreground",
  };
  const Icon =
    status === "done" ? FileCheck
    : status === "error" ? FileX
    : status === "cancelled" ? FileX
    : Loader2;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>
      <Icon className={`h-3 w-3 ${!isTerminal(status) ? "animate-spin" : ""}`} />
      {status}
    </span>
  );
}

export function ImportsPage() {
  const [jobs, setJobs] = useState<ImportJobStatus[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selected, setSelected] = useState<ImportJobStatus | null>(null);
  const [attachJobId, setAttachJobId] = useState<string | null>(null);
  const [openImport, setOpenImport] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (statusFilter && statusFilter !== "all") params.status = statusFilter;

    api
      .get<{ jobs: ImportJobStatus[]; total: number }>("/studies/import/jobs", { params, signal: ctrl.signal })
      .then(({ data }) => {
        setJobs(data.jobs);
        setTotal(data.total);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load imports");
        }
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [page, statusFilter, refreshNonce]);

  // Auto-refresh while there are active jobs visible.
  useEffect(() => {
    const hasActive = jobs.some((j) => !isTerminal(j.status));
    if (!hasActive) return;
    const t = setInterval(() => setRefreshNonce((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [jobs]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showing = useMemo(() => {
    if (total === 0) return "0 imports";
    const start = page * PAGE_SIZE + 1;
    const end = Math.min(total, start + jobs.length - 1);
    return `${start}–${end} of ${total}`;
  }, [page, total, jobs.length]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Imports</h1>
          <p className="text-sm text-muted-foreground">
            Every drag-and-drop import. Click a row to see file-level details.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setRefreshNonce((n) => n + 1)}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button onClick={() => setOpenImport(true)}>
            New import
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded p-3">
          {error}
        </div>
      )}

      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Started</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="w-[110px]">Status</TableHead>
              <TableHead className="w-[100px] text-right">Files</TableHead>
              <TableHead className="w-[110px] text-right">Stored / Dup</TableHead>
              <TableHead className="w-[80px] text-right">Failed</TableHead>
              <TableHead className="w-[90px] text-right">Elapsed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && jobs.length === 0 ? (
              <TableSkeleton rows={6} columns={7} />
            ) : jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                  No imports {statusFilter !== "all" && `with status "${statusFilter}"`}.
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((j) => (
                <TableRow
                  key={j.job_id}
                  className="cursor-pointer hover:bg-accent/50"
                  onClick={() => setSelected(j)}
                >
                  <TableCell className="text-sm">{fmtTimestamp(j.started_at)}</TableCell>
                  <TableCell className="text-sm max-w-[420px] truncate" title={j.source_label || j.job_id}>
                    {j.source_label || <span className="text-muted-foreground font-mono">{j.job_id.slice(0, 12)}</span>}
                  </TableCell>
                  <TableCell><StatusBadge status={j.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">
                    {j.total_files > 0 ? `${j.processed + j.failed}/${j.total_files}` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {j.new_instances} / {j.duplicate_instances}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${j.failed ? "text-destructive font-medium" : ""}`}>
                    {j.failed}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                    {fmtDuration(j.elapsed_seconds)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{showing}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm tabular-nums px-2">
            {page + 1} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Details drawer */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <StatusBadge status={selected.status} /> Import details
                </SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {selected.job_id}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 space-y-4 text-sm">
                {selected.source_label && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Source</div>
                    <div className="break-words">{selected.source_label}</div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Started" value={fmtTimestamp(selected.started_at)} />
                  <Field label="Finished" value={selected.finished_at ? fmtTimestamp(selected.finished_at) : "—"} />
                  <Field label="Elapsed" value={fmtDuration(selected.elapsed_seconds)} />
                  <Field label="Last progress" value={fmtTimestamp(selected.last_progress_at)} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat label="Files" value={selected.total_files || "—"} />
                  <Stat label="Processed" value={selected.processed} />
                  <Stat label="Failed" value={selected.failed} variant={selected.failed ? "danger" : undefined} />
                  <Stat label="New instances" value={selected.new_instances} />
                  <Stat label="Duplicates" value={selected.duplicate_instances} />
                  <Stat label="Studies" value={selected.studies_created} />
                </div>

                {selected.study_ids.length > 0 && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">
                      Studies created ({selected.study_ids.length})
                    </div>
                    <div className="space-y-1 max-h-40 overflow-auto border rounded p-2">
                      {selected.study_ids.map((sid) => (
                        <Link
                          key={sid}
                          to={`/studies/${sid}`}
                          className="block text-xs font-mono hover:underline truncate"
                          onClick={() => setSelected(null)}
                        >
                          {sid}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {selected.file_errors.length > 0 && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">
                      File errors ({selected.file_errors.length})
                    </div>
                    <div className="border rounded divide-y max-h-72 overflow-auto">
                      {selected.file_errors.map((fe: FileError, i) => (
                        <div key={i} className="p-2 text-xs">
                          <div className="font-mono truncate">{fe.name}</div>
                          <div className="text-destructive">{fe.reason}</div>
                          {fe.kind && (
                            <div className="text-muted-foreground mt-0.5">
                              kind: {fe.kind}{fe.http ? ` · HTTP ${fe.http}` : ""}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selected.errors.length > 0 && selected.file_errors.length === 0 && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-2">
                      Log ({selected.errors.length})
                    </div>
                    <div className="border rounded p-2 max-h-40 overflow-auto font-mono text-xs">
                      {selected.errors.map((e, i) => (
                        <div key={i} className="truncate">{e}</div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-2">
                  {!isTerminal(selected.status) && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAttachJobId(selected.job_id);
                        setSelected(null);
                      }}
                    >
                      Open live view
                    </Button>
                  )}
                  {selected.status === "error" && selected.upload_ids.length > 0 && (
                    <Button
                      variant="default"
                      onClick={async () => {
                        try {
                          await api.post(`/studies/import/${selected.job_id}/retry`);
                          setRefreshNonce((n) => n + 1);
                          setSelected(null);
                        } catch (e: unknown) {
                          const msg = e instanceof Error ? e.message : String(e);
                          setError(`Retry failed: ${msg}`);
                        }
                      }}
                    >
                      Retry
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Mountable dialogs — ImportsPage owns these so a row click can
           hand off into a live view, and the toolbar's "New import"
           opens a fresh upload session. */}
      {attachJobId && (
        <ImportDialog
          open={true}
          onOpenChange={(o) => { if (!o) { setAttachJobId(null); setRefreshNonce((n) => n + 1); } }}
          attachJobId={attachJobId}
        />
      )}
      {openImport && (
        <ImportDialog
          open={true}
          onOpenChange={(o) => { if (!o) { setOpenImport(false); setRefreshNonce((n) => n + 1); } }}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function Stat({ label, value, variant }: { label: string; value: number | string; variant?: "danger" }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-medium ${variant === "danger" && Number(value) > 0 ? "text-destructive" : ""}`}>
        {value}
      </div>
    </div>
  );
}
