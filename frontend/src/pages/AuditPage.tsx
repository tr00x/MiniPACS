import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { TableSkeleton } from "@/components/TableSkeleton";
import api from "@/lib/api";
import { formatTimestamp } from "@/lib/dicom";

interface AuditEntry {
  id: number;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  user_id: number | null;
  ip_address: string | null;
  timestamp: string;
}

interface User {
  id: number;
  username: string;
}

const PAGE_SIZE = 50;

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get("/users").then(({ data }) => setUsers(data)).catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (actionFilter) params.action = actionFilter;
    if (userFilter) params.user_id = Number(userFilter);
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;

    api
      .get("/audit-log", { params, signal: ctrl.signal })
      .then(({ data }) => {
        setEntries(data.items);
        setTotal(data.total);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load audit log");
        }
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [page, actionFilter, userFilter, dateFrom, dateTo]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const exportCsv = () => {
    const header = "Timestamp,Action,Resource Type,Resource ID,User,IP Address";
    const rows = entries.map(e => {
      const username = e.user_id != null ? (users.find(u => u.id === e.user_id)?.username ?? `#${e.user_id}`) : "";
      return [e.timestamp, e.action, e.resource_type || "", e.resource_id || "", username, e.ip_address || ""].map(v => `"${v}"`).join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Audit Log</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Audit Log</h2>
      <div className="flex flex-wrap gap-4">
        <Input
          placeholder="Filter by action..."
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
          className="max-w-[200px]"
        />
        <Select value={userFilter === "" ? "all" : userFilter} onValueChange={(val) => { setUserFilter(val === "all" ? "" : val); setPage(0); }}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>{u.username}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
          className="max-w-[160px]"
          placeholder="From"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
          className="max-w-[160px]"
          placeholder="To"
        />
        <Button variant="outline" size="sm" onClick={exportCsv} className="ml-auto">
          <Download className="mr-1 h-4 w-4" />
          Export CSV
        </Button>
      </div>
      {loading ? (
        <div className="rounded-lg border"><TableSkeleton columns={5} /></div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>User</TableHead>
                <TableHead>IP Address</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs">{formatTimestamp(e.timestamp)}</TableCell>
                  <TableCell className="font-mono text-sm">{e.action}</TableCell>
                  <TableCell className="text-xs">
                    {e.resource_type ? `${e.resource_type}/${e.resource_id ?? ""}` : "\u2014"}
                  </TableCell>
                  <TableCell>{e.user_id != null ? (users.find((u) => u.id === e.user_id)?.username ?? `#${e.user_id}`) : "\u2014"}</TableCell>
                  <TableCell className="font-mono text-xs">{e.ip_address ?? "\u2014"}</TableCell>
                </TableRow>
              ))}
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No audit entries found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Page {page + 1} of {totalPages} ({total} entries)
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
