import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { TableSkeleton } from "@/components/TableSkeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { RefreshCw, ArrowRightLeft, CheckCircle, XCircle, Clock, AlertCircle } from "lucide-react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
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
}

const statusConfig: Record<Transfer["status"], { variant: "default" | "destructive" | "secondary"; icon: typeof CheckCircle; label: string }> = {
  success: { variant: "default", icon: CheckCircle, label: "Success" },
  failed: { variant: "destructive", icon: XCircle, label: "Failed" },
  pending: { variant: "secondary", icon: Clock, label: "Pending" },
};

type StatusFilter = "all" | "success" | "failed" | "pending";

function formatDuration(created: string, completed: string | null): string {
  if (!completed) return "—";
  const ms = new Date(completed).getTime() - new Date(created).getTime();
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function TransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [errorDetail, setErrorDetail] = useState<{ pacs: string; error: string; date: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTransfers = (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    api
      .get("/transfers", { signal })
      .then(({ data }) => setTransfers(data))
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load transfers");
        }
      })
      .finally(() => setLoading(false));
  };

  const fetchTransfersSilent = () => {
    api
      .get("/transfers")
      .then(({ data }) => setTransfers(data))
      .catch(() => {});
  };

  useEffect(() => {
    const ctrl = new AbortController();
    fetchTransfers(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  // Auto-refresh when pending transfers exist
  useEffect(() => {
    const hasPending = transfers.some((t) => t.status === "pending");
    if (hasPending) {
      intervalRef.current = setInterval(fetchTransfersSilent, 10_000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [transfers]);

  const handleRetry = async (id: number) => {
    setRetrying(id);
    try {
      await api.post(`/transfers/${id}/retry`);
      fetchTransfers();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to retry transfer");
    } finally {
      setRetrying(null);
    }
  };

  const successCount = transfers.filter((t) => t.status === "success").length;
  const failedCount = transfers.filter((t) => t.status === "failed").length;
  const pendingCount = transfers.filter((t) => t.status === "pending").length;

  const filtered = statusFilter === "all"
    ? transfers
    : transfers.filter((t) => t.status === statusFilter);

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Transfers</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Transfers</h2>
        <p className="text-sm text-muted-foreground">DICOM study transfer history</p>
      </div>

      <div className="flex gap-4">
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-emerald-500/10 p-2">
              <CheckCircle className="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{successCount}</p>
              <p className="text-xs text-muted-foreground">Successful</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-red-500/10 p-2">
              <XCircle className="h-5 w-5 text-red-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{failedCount}</p>
              <p className="text-xs text-muted-foreground">Failed</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-amber-500/10 p-2">
              <Clock className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{pendingCount}</p>
              <p className="text-xs text-muted-foreground">Pending</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
        {pendingCount > 0 && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Auto-refreshing every 10s
          </p>
        )}
      </div>

      {loading ? (
        <div className="rounded-lg border">
          <TableSkeleton columns={7} />
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Destination</TableHead>
                <TableHead>Study</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const cfg = statusConfig[t.status];
                const StatusIcon = cfg.icon;
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div>
                        <span className="font-medium">{t.pacs_node_name ?? "Unknown"}</span>
                        <span className="ml-1 text-xs text-muted-foreground">
                          {t.pacs_node_ae_title ?? ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link to={`/studies/${t.orthanc_study_id}`} className="hover:underline">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs cursor-pointer">
                          {(t.orthanc_study_id ?? "").slice(0, 12)}…
                        </code>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={cfg.variant} className="gap-1">
                        <StatusIcon className="h-3 w-3" />
                        {cfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatTimestamp(t.created_at)}
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {formatDuration(t.created_at, t.completed_at)}
                    </TableCell>
                    <TableCell>
                      {t.error_message ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto px-2 py-1 gap-1 text-destructive hover:text-destructive"
                          onClick={() => setErrorDetail({
                            pacs: t.pacs_node_name || "Unknown",
                            error: t.error_message!,
                            date: t.created_at,
                          })}
                        >
                          <AlertCircle className="h-3.5 w-3.5" />
                          <span className="text-xs">View Error</span>
                        </Button>
                      ) : "—"}
                    </TableCell>
                    <TableCell>
                      {t.status === "failed" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetry(t.id)}
                          disabled={retrying === t.id}
                          className="gap-1"
                        >
                          <RefreshCw className={`h-3 w-3 ${retrying === t.id ? "animate-spin" : ""}`} />
                          Retry
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    <ArrowRightLeft className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    {statusFilter === "all" ? "No transfers yet" : `No ${statusFilter} transfers`}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {/* Error Detail Dialog */}
      <Dialog open={!!errorDetail} onOpenChange={(open) => { if (!open) setErrorDetail(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer Error Details</DialogTitle>
          </DialogHeader>
          {errorDetail && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Destination</p>
                  <p className="font-medium">{errorDetail.pacs}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p>{formatTimestamp(errorDetail.date)}</p>
                </div>
              </div>
              <div className="rounded-md border bg-destructive/5 p-4">
                <p className="text-xs font-medium text-destructive mb-2">Error Message</p>
                <pre className="text-sm whitespace-pre-wrap break-all">{errorDetail.error}</pre>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this error with IT support if you need help resolving the issue.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
