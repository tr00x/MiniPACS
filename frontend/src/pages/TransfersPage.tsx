import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { TableSkeleton } from "@/components/TableSkeleton";
import { PageError } from "@/components/page-error";
import { RefreshCw, ArrowRightLeft, CheckCircle, XCircle, Clock, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import api, { getErrorMessage } from "@/lib/api";
import { formatTimestamp } from "@/lib/dicom";

interface Transfer {
  id: number;
  orthanc_study_id: string;
  pacs_node_name: string | null;
  pacs_node_ae_title: string | null;
  status: "success" | "failed" | "pending";
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  // Inlined by /api/transfers — replaces the old per-row /api/studies/{id} fan-out.
  study_description?: string;
  patient_name?: string;
}

const PAGE_SIZE = 50;

const statusConfig: Record<Transfer["status"], { variant: "default" | "destructive" | "secondary"; icon: typeof CheckCircle; label: string }> = {
  success: { variant: "default", icon: CheckCircle, label: "Delivered" },
  failed: { variant: "destructive", icon: XCircle, label: "Failed" },
  pending: { variant: "secondary", icon: Clock, label: "Sending..." },
};

type StatusFilter = "all" | "success" | "failed" | "pending";

function ensureUTC(ts: string): string {
  return ts.endsWith("Z") ? ts : ts + "Z";
}

function formatDuration(created: string, completed: string | null): string {
  if (!completed) return "\u2014";
  const ms = new Date(ensureUTC(completed)).getTime() - new Date(ensureUTC(created)).getTime();
  if (ms < 0 || ms > 86400000) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(ensureUTC(isoString)).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function humanizeError(raw: string): string {
  if (raw.includes("not found") || raw.includes("404")) return "PACS node not registered. Remove and re-add it in PACS Nodes settings.";
  if (raw.includes("timeout") || raw.includes("Timeout")) return "Connection timed out. The destination may be offline or unreachable.";
  if (raw.includes("refused") || raw.includes("Refused")) return "Connection refused. The destination is not accepting connections.";
  if (raw.includes("network") || raw.includes("Network")) return "Network error. Check that the destination IP and port are correct.";
  return "Transfer failed. See technical details below.";
}

export function TransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [total, setTotal] = useState(0);
  const [allTransfers, setAllTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Error detail dialog
  const [errorDetail, setErrorDetail] = useState<Transfer | null>(null);

  const fetchAll = (signal?: AbortSignal) => {
    api
      .get("/transfers", { params: { limit: 1000 }, signal })
      .then(({ data }) => {
        const items = data.items ?? data;
        setAllTransfers(items);
      })
      .catch(() => {});
  };

  const fetchPage = (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    if (statusFilter !== "all") params.status = statusFilter;
    api
      .get("/transfers", { params, signal })
      .then(({ data }) => {
        const items = data.items ?? data;
        const tot = data.total ?? items.length;
        setTransfers(items);
        setTotal(tot);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(getErrorMessage(err, "Failed to load transfers"));
        }
      })
      .finally(() => setLoading(false));
  };

  const fetchSilent = () => {
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    if (statusFilter !== "all") params.status = statusFilter;
    api
      .get("/transfers", { params })
      .then(({ data }) => {
        const items = data.items ?? data;
        const tot = data.total ?? items.length;
        setTransfers((prev) => {
          for (const t of items) {
            const old = prev.find((p) => p.id === t.id);
            if (old && old.status === "pending" && t.status === "success") {
              toast.success(`Transfer to ${t.pacs_node_name || "PACS"} completed`);
            }
            if (old && old.status === "pending" && t.status === "failed") {
              toast.error(`Transfer to ${t.pacs_node_name || "PACS"} failed`);
            }
          }
          return items;
        });
        setTotal(tot);
      })
      .catch(() => {});
    // Also refresh counts
    fetchAll();
  };

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAll(ctrl.signal);
    fetchPage(ctrl.signal);
    return () => ctrl.abort();
  }, [statusFilter, page]);

  // Auto-refresh when pending transfers exist
  useEffect(() => {
    const hasPending = allTransfers.some((t) => t.status === "pending");
    if (hasPending && !intervalRef.current) {
      intervalRef.current = setInterval(fetchSilent, 5_000);
    } else if (!hasPending && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [allTransfers]);

  const handleStatusFilter = (f: StatusFilter) => {
    setStatusFilter(f);
    setPage(1);
  };

  const handleRetry = async (t: Transfer) => {
    setRetrying(t.id);
    try {
      const { data } = await api.post(`/transfers/${t.id}/retry`);
      if (data.status === "success") {
        toast.success(`Retried successfully \u2014 delivered to ${t.pacs_node_name || "PACS"}`);
      } else if (data.status === "failed") {
        toast.error(`Retry failed \u2014 ${humanizeError(data.error_message || "")}`);
      } else {
        toast.info("Retry initiated \u2014 transfer is pending");
      }
      fetchAll();
      fetchPage();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to retry transfer"));
    } finally {
      setRetrying(null);
    }
  };

  const handleRetryAllFailed = async () => {
    const failed = allTransfers.filter((t) => t.status === "failed");
    if (failed.length === 0) return;
    toast.info(`Retrying ${failed.length} failed transfer${failed.length > 1 ? "s" : ""}...`);
    await Promise.allSettled(failed.map((t) => api.post(`/transfers/${t.id}/retry`)));
    fetchAll();
    fetchPage();
  };

  const successCount = allTransfers.filter((t) => t.status === "success").length;
  const failedCount = allTransfers.filter((t) => t.status === "failed").length;
  const pendingCount = allTransfers.filter((t) => t.status === "pending").length;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Transfers</h2>
        <PageError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Transfers</h2>
          <p className="text-sm text-muted-foreground">DICOM study transfer history</p>
        </div>
        {failedCount > 0 && (
          <Button variant="outline" onClick={handleRetryAllFailed} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry All Failed ({failedCount})
          </Button>
        )}
      </div>

      {/* Compact status filter chips */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5">
          <Button
            variant={statusFilter === "all" ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => handleStatusFilter("all")}
          >
            All ({allTransfers.length})
          </Button>
          <Button
            variant={statusFilter === "success" ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => handleStatusFilter("success")}
          >
            <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
            Delivered ({successCount})
          </Button>
          <Button
            variant={statusFilter === "failed" ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => handleStatusFilter("failed")}
          >
            <XCircle className="h-3.5 w-3.5 text-destructive" />
            Failed ({failedCount})
          </Button>
          <Button
            variant={statusFilter === "pending" ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => handleStatusFilter("pending")}
          >
            <Clock className={`h-3.5 w-3.5 text-amber-500${pendingCount > 0 ? " animate-pulse" : ""}`} />
            Pending ({pendingCount})
          </Button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          {pendingCount} transfer{pendingCount > 1 ? "s" : ""} in progress — auto-refreshing every 5s
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border">
          <TableSkeleton columns={5} />
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Destination</TableHead>
                <TableHead>Study</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="w-[160px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.map((t) => {
                const cfg = statusConfig[t.status];
                const StatusIcon = cfg.icon;
                return (
                  <TableRow key={t.id} className={t.status === "failed" ? "bg-destructive/5" : t.status === "pending" ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-sm">{t.pacs_node_name ?? "Unknown"}</span>
                        {t.pacs_node_ae_title && (
                          <span className="text-xs text-muted-foreground">{t.pacs_node_ae_title}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <Link to={`/studies/${t.orthanc_study_id}`} className="text-primary hover:underline text-sm font-medium">
                          {t.study_description || t.orthanc_study_id.slice(0, 12) + "\u2026"}
                        </Link>
                        {t.patient_name && (
                          <span className="text-xs text-muted-foreground">{t.patient_name.replace(/\^/g, " ")}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={cfg.variant} className="gap-1 w-fit">
                          {t.status === "pending" ? (
                            <div className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                          ) : (
                            <StatusIcon className="h-3 w-3" />
                          )}
                          {cfg.label}
                        </Badge>
                        {t.status !== "pending" && (
                          <span className="text-xs text-muted-foreground font-mono">
                            {formatDuration(t.created_at, t.completed_at)}
                          </span>
                        )}
                        {t.status === "pending" && (
                          <span className="text-xs text-amber-600 animate-pulse">sending...</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm" title={formatTimestamp(t.created_at)}>
                          {formatRelativeTime(t.created_at)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTimestamp(t.created_at)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {t.status === "failed" && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 gap-1 text-destructive hover:text-destructive"
                              onClick={() => setErrorDetail(t)}
                            >
                              <AlertCircle className="h-3.5 w-3.5" />
                              Error
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1"
                              onClick={() => handleRetry(t)}
                              disabled={retrying === t.id}
                            >
                              <RefreshCw className={`h-3 w-3 ${retrying === t.id ? "animate-spin" : ""}`} />
                              Retry
                            </Button>
                          </>
                        )}
                        {t.status === "success" && (
                          <span className="text-xs text-emerald-600 flex items-center gap-1">
                            <CheckCircle className="h-3 w-3" /> Delivered
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {transfers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    <ArrowRightLeft className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    {statusFilter === "all" ? "No transfers yet. Send a study from the Study Detail page." : `No ${statusFilter} transfers`}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {/* Pagination */}
          {total > 0 && totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages} ({total} transfers)
              </p>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error Detail Dialog */}
      <Dialog open={!!errorDetail} onOpenChange={(open) => { if (!open) setErrorDetail(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Transfer Error</DialogTitle>
            <DialogDescription>
              Transfer #{errorDetail?.id} to {errorDetail?.pacs_node_name || "Unknown PACS"}
            </DialogDescription>
          </DialogHeader>
          {errorDetail && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Destination</p>
                  <p className="font-medium">{errorDetail.pacs_node_name}</p>
                  <p className="text-xs text-muted-foreground">{errorDetail.pacs_node_ae_title}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Attempted</p>
                  <p>{formatTimestamp(errorDetail.created_at)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Duration</p>
                  <p>{formatDuration(errorDetail.created_at, errorDetail.completed_at)}</p>
                </div>
              </div>

              {/* Human-readable explanation */}
              <div className="rounded-md border-l-4 border-destructive bg-destructive/5 p-4">
                <p className="text-sm font-medium mb-1">What happened</p>
                <p className="text-sm text-muted-foreground">
                  {humanizeError(errorDetail.error_message || "")}
                </p>
              </div>

              {/* Raw error for IT */}
              <details className="rounded-md border bg-muted/50 p-3">
                <summary className="text-xs font-medium cursor-pointer text-muted-foreground">
                  Technical details (share with IT support)
                </summary>
                <pre className="mt-2 text-xs whitespace-pre-wrap break-all font-mono">
                  {errorDetail.error_message}
                </pre>
              </details>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setErrorDetail(null)}>Close</Button>
                <Button onClick={() => { setErrorDetail(null); handleRetry(errorDetail); }}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry This Transfer
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
