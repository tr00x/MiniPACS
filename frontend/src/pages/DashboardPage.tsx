import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, FileImage, ArrowRightLeft, Eye, AlertCircle, CheckCircle, XCircle, Clock, HardDrive } from "lucide-react";
import { CardSkeleton } from "@/components/CardSkeleton";
import { PageError } from "@/components/page-error";
import { StatusDot } from "@/components/ui/status-dot";
import api from "@/lib/api";
import { formatDicomName, formatTimestamp } from "@/lib/dicom";

interface ApiStats {
  patients_total: number;
  studies_total: number;
  studies_today: number;
  transfers_week: number;
  failed_transfers: number;
  unviewed_shares: number;
}

interface SystemHealth {
  orthanc: {
    status: "online" | "offline";
    version?: string;
    storage_size?: string;
    dicom_aet?: string;
    count_studies?: number;
    count_instances?: number;
  };
  last_received: string | null;
}

interface Transfer {
  id: number;
  orthanc_study_id: string;
  pacs_node_name: string | null;
  pacs_node_ae_title: string | null;
  status: "success" | "failed" | "pending";
  created_at: string;
}

interface Share {
  id: number;
  orthanc_patient_id: string;
  token: string;
  is_active: number;
  view_count: number;
  created_at: string;
  expires_at: string | null;
}

interface Patient {
  ID: string;
  MainDicomTags: { PatientName?: string };
}

function formatOrthancDate(dateStr: string): string {
  // Orthanc dates: "20260412T043541" in UTC → readable format
  const clean = dateStr.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6Z");
  const date = new Date(clean);
  if (isNaN(date.getTime())) return dateStr;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin < 1) return "<1m ago";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function DashboardPage() {
  const [stats, setStats] = useState<ApiStats | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [listsLoading, setListsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;

    // Fetch stats and system health in parallel
    Promise.all([
      api.get<ApiStats>("/stats", { signal }),
      api.get<SystemHealth>("/stats/system-health", { signal }).catch(() => ({
        data: { orthanc: { status: "offline" as const }, last_received: null },
      })),
    ])
      .then(([statsRes, healthRes]) => {
        setStats(statsRes.data);
        setHealth(healthRes.data);
      })
      .catch((err) => {
        if (err.name !== "CanceledError") setError(err?.response?.data?.detail ?? err.message);
      })
      .finally(() => setStatsLoading(false));

    Promise.all([
      api.get("/transfers", { params: { limit: 5 }, signal }),
      api.get("/shares", { signal }),
      api.get("/patients", { params: { limit: 100 }, signal }),
    ])
      .then(([t, s, p]) => {
        const transferItems = t.data.items ?? t.data;
        setTransfers(Array.isArray(transferItems) ? transferItems.slice(0, 5) : []);
        const sharesData = s.data.items ?? s.data;
        setShares((Array.isArray(sharesData) ? sharesData : []).filter((sh: Share) => sh.is_active).slice(0, 5));
        const patientItems = p.data.items ?? p.data;
        setPatients(Array.isArray(patientItems) ? patientItems : []);
      })
      .catch(() => {})
      .finally(() => setListsLoading(false));

    return () => ctrl.abort();
  }, []);

  const getPatientName = (orthancId: string) => {
    const p = patients.find((pt) => pt.ID === orthancId);
    return p ? formatDicomName(p.MainDicomTags?.PatientName || "") : null;
  };

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <PageError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const failedCount = stats?.failed_transfers ?? 0;
  const orthancStatus = health?.orthanc?.status ?? "offline";

  return (
    <div className="space-y-6">
      {/* System Health Strip */}
      <Card className="bg-muted/30">
        <CardContent className="flex items-center gap-6 py-3 px-4">
          <div className="flex items-center gap-2">
            <StatusDot status={orthancStatus === "online" ? "online" : "offline"} />
            <span className="text-sm font-medium">PACS Server</span>
          </div>
          {orthancStatus === "online" && health?.orthanc && (
            <>
              <div className="h-4 w-px bg-border" />
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <HardDrive className="h-3 w-3" />
                {health.orthanc.storage_size}
              </div>
              <div className="h-4 w-px bg-border" />
              <div className="text-xs text-muted-foreground">
                {health.orthanc.count_studies ?? 0} studies · {health.orthanc.count_instances ?? 0} images
              </div>
              <div className="h-4 w-px bg-border" />
              <div className="text-xs text-muted-foreground">
                Last received: {health.last_received ? formatOrthancDate(health.last_received) : "never"}
              </div>
            </>
          )}
          {orthancStatus === "offline" && (
            <>
              <div className="h-4 w-px bg-border" />
              <span className="text-xs text-destructive">PACS server unreachable</span>
            </>
          )}
        </CardContent>
      </Card>

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statsLoading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <Link to="/patients" className="block">
              <Card className="transition-colors hover:bg-accent/50">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Patients</p>
                      <p className="text-3xl font-bold mt-1">{stats?.patients_total ?? 0}</p>
                    </div>
                    <div className="rounded-lg bg-blue-500/10 p-3">
                      <Users className="h-5 w-5 text-blue-500" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link to="/studies" className="block">
              <Card className="transition-colors hover:bg-accent/50">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Studies Today</p>
                      <p className="text-3xl font-bold mt-1">{stats?.studies_today ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">{stats?.studies_total ?? 0} total</p>
                    </div>
                    <div className="rounded-lg bg-emerald-500/10 p-3">
                      <FileImage className="h-5 w-5 text-emerald-500" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link to="/transfers" className="block">
              <Card className={`transition-colors hover:bg-accent/50 ${failedCount > 0 ? "border-destructive/50" : ""}`}>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Transfers This Week</p>
                      <p className="text-3xl font-bold mt-1">{stats?.transfers_week ?? 0}</p>
                      {failedCount > 0 && (
                        <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" /> {failedCount} failed
                        </p>
                      )}
                    </div>
                    <div className={`rounded-lg p-3 ${failedCount > 0 ? "bg-destructive/10" : "bg-violet-500/10"}`}>
                      <ArrowRightLeft className={`h-5 w-5 ${failedCount > 0 ? "text-destructive" : "text-violet-500"}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link to="/shares" className="block">
              <Card className="transition-colors hover:bg-accent/50">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Unviewed Shares</p>
                      <p className="text-3xl font-bold mt-1">{stats?.unviewed_shares ?? 0}</p>
                    </div>
                    <div className="rounded-lg bg-amber-500/10 p-3">
                      <Eye className="h-5 w-5 text-amber-500" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </>
        )}
      </div>

      {/* Activity Lists */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Transfers */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium">Recent Transfers</CardTitle>
            <Link to="/transfers" className="text-xs text-primary hover:underline">View all</Link>
          </CardHeader>
          <CardContent>
            {listsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
              </div>
            ) : transfers.length === 0 ? (
              <div className="py-6 text-center">
                <ArrowRightLeft className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No transfers yet</p>
              </div>
            ) : (
              <div className="space-y-1">
                {transfers.map((t) => (
                  <Link
                    key={t.id}
                    to="/transfers"
                    className="flex items-center justify-between rounded-md px-3 py-2.5 hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        t.status === "success" ? "bg-emerald-500/10" : t.status === "failed" ? "bg-destructive/10" : "bg-amber-500/10"
                      }`}>
                        {t.status === "success" ? <CheckCircle className="h-4 w-4 text-emerald-500" /> :
                         t.status === "failed" ? <XCircle className="h-4 w-4 text-destructive" /> :
                         <Clock className="h-4 w-4 text-amber-500 animate-pulse" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{t.pacs_node_name || "Unknown PACS"}</p>
                        <p className="text-xs text-muted-foreground">{formatTimestamp(t.created_at)}</p>
                      </div>
                    </div>
                    <Badge variant={t.status === "success" ? "default" : t.status === "failed" ? "destructive" : "secondary"} className="shrink-0 ml-2">
                      {t.status === "success" ? "Delivered" : t.status === "failed" ? "Failed" : "Sending..."}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Shares */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium">Active Patient Shares</CardTitle>
            <Link to="/shares" className="text-xs text-primary hover:underline">View all</Link>
          </CardHeader>
          <CardContent>
            {listsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
              </div>
            ) : shares.length === 0 ? (
              <div className="py-6 text-center">
                <Eye className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No active shares</p>
              </div>
            ) : (
              <div className="space-y-1">
                {shares.map((s) => {
                  const patientName = getPatientName(s.orthanc_patient_id);
                  return (
                    <Link
                      key={s.id}
                      to="/shares"
                      className="flex items-center justify-between rounded-md px-3 py-2.5 hover:bg-accent/50 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{patientName || "Patient"}</p>
                        <p className="text-xs text-muted-foreground">
                          {s.expires_at ? `Expires ${formatTimestamp(s.expires_at)}` : "No expiry"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {s.view_count > 0 ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                            <Eye className="h-3 w-3" /> {s.view_count}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not viewed</span>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
