import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw } from "lucide-react";
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

const statusVariant: Record<Transfer["status"], "default" | "destructive" | "secondary"> = {
  success: "default",
  failed: "destructive",
  pending: "secondary",
};

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

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Transfers</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Transfers</h2>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Study</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Completed</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfers.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-mono text-xs">
                  {(t.orthanc_study_id ?? "").slice(0, 12)}...
                </TableCell>
                <TableCell>
                  {t.pacs_node_name ?? "Unknown"}{" "}
                  <span className="text-muted-foreground text-xs">
                    ({t.pacs_node_ae_title ?? ""})
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant[t.status]}>{t.status}</Badge>
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-destructive">
                  {t.error_message || "\u2014"}
                </TableCell>
                <TableCell className="text-xs">{t.created_at}</TableCell>
                <TableCell className="text-xs">{t.completed_at || "\u2014"}</TableCell>
                <TableCell>
                  {t.status === "failed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRetry(t.id)}
                      disabled={retrying === t.id}
                    >
                      <RefreshCw className={`mr-1 h-3 w-3 ${retrying === t.id ? "animate-spin" : ""}`} />
                      Retry
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {transfers.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No transfers found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
