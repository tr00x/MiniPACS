import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Copy, Ban } from "lucide-react";
import api from "@/lib/api";

interface Share {
  id: number;
  orthanc_patient_id: string;
  token: string;
  is_active: number;
  view_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  created_at: string;
  expires_at: string | null;
  created_by_username: string | null;
}

function getShareStatus(s: Share): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (!s.is_active) return { label: "Revoked", variant: "secondary" };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { label: "Expired", variant: "destructive" };
  return { label: "Active", variant: "default" };
}

export function SharesPage() {
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);

  const fetchShares = (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    api
      .get("/shares", { signal })
      .then(({ data }) => setShares(data))
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load shares");
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const ctrl = new AbortController();
    fetchShares(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  const handleRevoke = async (id: number) => {
    setRevoking(id);
    try {
      await api.delete(`/shares/${id}`);
      fetchShares();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to revoke share");
    } finally {
      setRevoking(null);
    }
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
  };

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Patient Shares</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Patient Shares</h2>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Patient ID</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Views</TableHead>
              <TableHead>First Viewed</TableHead>
              <TableHead>Last Viewed</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Created By</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shares.map((s) => {
              const status = getShareStatus(s);
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">
                    {(s.orthanc_patient_id ?? "").slice(0, 12)}...
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs">
                        {(s.token ?? "").slice(0, 16)}...
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyToken(s.token)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                  <TableCell>{s.view_count}</TableCell>
                  <TableCell className="text-xs">{s.first_viewed_at || "\u2014"}</TableCell>
                  <TableCell className="text-xs">{s.last_viewed_at || "\u2014"}</TableCell>
                  <TableCell className="text-xs">{s.expires_at || "No expiry"}</TableCell>
                  <TableCell className="text-xs">{s.created_by_username || "\u2014"}</TableCell>
                  <TableCell>
                    {s.is_active ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => handleRevoke(s.id)}
                        disabled={revoking === s.id}
                      >
                        <Ban className="mr-1 h-3 w-3" />
                        Revoke
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
            {shares.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No shares found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
