import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, ArrowRightLeft, CheckCircle, XCircle, Clock } from "lucide-react";
import api from "@/lib/api";

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

function formatTimestamp(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

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

  useEffect(() => {
    const ctrl = new AbortController();
    fetchTransfers(ctrl.signal);
    return () => ctrl.abort();
  }, []);

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

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
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
              {transfers.map((t) => {
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
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {(t.orthanc_study_id ?? "").slice(0, 12)}…
                      </code>
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
                        <span className="text-xs text-destructive">{t.error_message}</span>
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
              {transfers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    <ArrowRightLeft className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    No transfers yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
