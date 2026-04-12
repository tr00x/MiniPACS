import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileImage, Users, AlertCircle, Eye } from "lucide-react";
import api from "@/lib/api";

interface Transfer {
  id: number;
  pacs_name: string;
  status: string;
}

interface Share {
  id: number;
  token: string;
  is_active: boolean;
  view_count: number;
}

interface Stats {
  totalPatients: number;
  totalStudies: number;
  recentTransfers: Transfer[];
  activeShares: Share[];
}

export function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    Promise.all([
      api.get("/patients", { signal }),
      api.get("/studies", { signal }),
      api.get("/transfers", { signal }),
      api.get("/shares", { signal }),
    ])
      .then(([patients, studies, transfers, shares]) => {
        setStats({
          totalPatients: patients.data.length,
          totalStudies: studies.data.length,
          recentTransfers: transfers.data.slice(0, 5),
          activeShares: shares.data.filter((s: Share) => s.is_active),
        });
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load dashboard data");
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }

  if (!stats) return <div className="text-muted-foreground">Loading...</div>;

  const failedTransfers = stats.recentTransfers.filter((t) => t.status === "failed");
  const unviewedShares = stats.activeShares.filter((s) => s.view_count === 0);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Patients</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalPatients}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Studies</CardTitle>
            <FileImage className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalStudies}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed Transfers</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{failedTransfers.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unviewed Shares</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{unviewedShares.length}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent Transfers</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recentTransfers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transfers yet</p>
            ) : (
              <div className="space-y-2">
                {stats.recentTransfers.map((t) => (
                  <div key={t.id} className="flex items-center justify-between text-sm">
                    <span>{t.pacs_name}</span>
                    <span className={t.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                      {t.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Active Patient Shares</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.activeShares.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active shares</p>
            ) : (
              <div className="space-y-2">
                {stats.activeShares.slice(0, 5).map((s) => (
                  <div key={s.id} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs">{(s.token ?? "").slice(0, 12)}...</span>
                    <span className="text-muted-foreground">
                      {s.view_count} views
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
