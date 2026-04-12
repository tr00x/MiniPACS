import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileImage, Users, ArrowLeftRight, Eye } from "lucide-react";
import { CardSkeleton } from "@/components/CardSkeleton";
import { useAuth } from "@/lib/auth";
import api from "@/lib/api";

interface ApiStats {
  patients_total: number;
  studies_today: number;
  transfers_week: number;
  unviewed_shares: number;
}

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

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [apiStats, setApiStats] = useState<ApiStats | null>(null);
  const [recentTransfers, setRecentTransfers] = useState<Transfer[]>([]);
  const [activeShares, setActiveShares] = useState<Share[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [listsLoading, setListsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    api
      .get<ApiStats>("/stats", { signal })
      .then(({ data }) => {
        setApiStats(data);
        setStatsLoading(false);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load stats");
          setStatsLoading(false);
        }
      });

    Promise.all([
      api.get<Transfer[]>("/transfers", { signal }),
      api.get<Share[]>("/shares", { signal }),
    ])
      .then(([transfersRes, sharesRes]) => {
        setRecentTransfers(transfersRes.data.slice(0, 5));
        setActiveShares(sharesRes.data.filter((s) => s.is_active));
        setListsLoading(false);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setListsLoading(false);
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Welcome back, {user?.username}
        </h2>
        <p className="text-sm text-muted-foreground">{today}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statsLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : (
          <>
            <Link to="/patients" className="block">
              <Card className="cursor-pointer transition-colors hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Patients</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{apiStats?.patients_total ?? 0}</div>
                </CardContent>
              </Card>
            </Link>

            <Link to="/studies" className="block">
              <Card className="cursor-pointer transition-colors hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Studies Today</CardTitle>
                  <FileImage className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{apiStats?.studies_today ?? 0}</div>
                </CardContent>
              </Card>
            </Link>

            <Link to="/transfers" className="block">
              <Card className="cursor-pointer transition-colors hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Transfers This Week</CardTitle>
                  <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{apiStats?.transfers_week ?? 0}</div>
                </CardContent>
              </Card>
            </Link>

            <Link to="/shares" className="block">
              <Card className="cursor-pointer transition-colors hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Unviewed Shares</CardTitle>
                  <Eye className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{apiStats?.unviewed_shares ?? 0}</div>
                </CardContent>
              </Card>
            </Link>
          </>
        )}
      </div>

      <div className="flex gap-3">
        <Button onClick={() => navigate("/shares")}>Create Share Link</Button>
        <Button variant="outline" onClick={() => navigate("/transfers")}>View Transfers</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Recent Transfers</CardTitle>
            <Link to="/transfers" className="text-xs text-muted-foreground hover:text-foreground">View all</Link>
          </CardHeader>
          <CardContent>
            {listsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-7 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : recentTransfers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transfers yet</p>
            ) : (
              <div className="space-y-2">
                {recentTransfers.map((t) => (
                  <Link
                    key={t.id}
                    to="/transfers"
                    className="flex items-center justify-between text-sm rounded-md px-2 py-1 -mx-2 hover:bg-accent/50"
                  >
                    <span>{t.pacs_name}</span>
                    <span className={t.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                      {t.status}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Active Patient Shares</CardTitle>
            <Link to="/shares" className="text-xs text-muted-foreground hover:text-foreground">View all</Link>
          </CardHeader>
          <CardContent>
            {listsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-7 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : activeShares.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active shares</p>
            ) : (
              <div className="space-y-2">
                {activeShares.slice(0, 5).map((s) => (
                  <Link
                    key={s.id}
                    to="/shares"
                    className="flex items-center justify-between text-sm rounded-md px-2 py-1 -mx-2 hover:bg-accent/50"
                  >
                    <span className="font-mono text-xs">{(s.token ?? "").slice(0, 12)}...</span>
                    <span className="text-muted-foreground">{s.view_count} views</span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
