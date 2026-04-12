import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Copy, Check, Ban, Link2, Eye, EyeOff, Share2, Plus, Pencil, CalendarClock } from "lucide-react";
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

interface Patient {
  ID: string;
  MainDicomTags: {
    PatientName?: string;
    PatientID?: string;
  };
}

function getShareStatus(s: Share): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (!s.is_active) return { label: "Revoked", variant: "secondary" };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { label: "Expired", variant: "destructive" };
  return { label: "Active", variant: "default" };
}

function formatTimestamp(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function formatDicomName(raw: string): string {
  if (!raw) return "Unknown";
  const parts = raw.split("^");
  const last = parts[0] || "";
  const first = parts[1] || "";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (first && last) return `${cap(first)} ${cap(last)}`;
  return cap(last || first);
}

const EXPIRY_PRESETS = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "No expiry", days: 0 },
];

export function SharesPage() {
  const [shares, setShares] = useState<Share[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState("");
  const [expiryPreset, setExpiryPreset] = useState("30");
  const [customExpiry, setCustomExpiry] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog
  const [editShare, setEditShare] = useState<Share | null>(null);
  const [editExpiry, setEditExpiry] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
    api.get("/patients", { signal: ctrl.signal })
      .then(({ data }) => setPatients(data))
      .catch(() => {});
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

  const handleCreate = async () => {
    if (!selectedPatient) return;
    setCreating(true);
    setCreateError(null);

    let expires_at: string | null = null;
    const days = parseInt(expiryPreset);
    if (days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      expires_at = d.toISOString();
    } else if (expiryPreset === "custom" && customExpiry) {
      expires_at = new Date(customExpiry).toISOString();
    }

    try {
      await api.post("/shares", {
        orthanc_patient_id: selectedPatient,
        expires_at,
      });
      setCreateOpen(false);
      setSelectedPatient("");
      setExpiryPreset("30");
      setCustomExpiry("");
      fetchShares();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setCreateError(e?.response?.data?.detail ?? e?.message ?? "Failed to create share");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (s: Share) => {
    setEditShare(s);
    setEditExpiry(s.expires_at ? s.expires_at.slice(0, 16) : "");
    setEditError(null);
  };

  const handleEdit = async () => {
    if (!editShare) return;
    setSaving(true);
    setEditError(null);
    try {
      await api.put(`/shares/${editShare.id}`, {
        expires_at: editExpiry ? new Date(editExpiry).toISOString() : null,
      });
      setEditShare(null);
      fetchShares();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setEditError(e?.response?.data?.detail ?? e?.message ?? "Failed to update share");
    } finally {
      setSaving(false);
    }
  };

  const copyLink = (share: Share) => {
    const url = `${window.location.origin}/patient-portal/${share.token}`;
    navigator.clipboard.writeText(url);
    setCopiedId(share.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const activeCount = shares.filter((s) => s.is_active && !(s.expires_at && new Date(s.expires_at) < new Date())).length;
  const viewedCount = shares.filter((s) => s.view_count > 0).length;
  const totalViews = shares.reduce((sum, s) => sum + s.view_count, 0);

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Patient Shares</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Patient Shares</h2>
          <p className="text-sm text-muted-foreground">Patient portal access links</p>
        </div>
        <Button onClick={() => { setCreateOpen(true); setCreateError(null); }}>
          <Plus className="mr-2 h-4 w-4" />
          Create Share Link
        </Button>
      </div>

      <div className="flex gap-4">
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-blue-500/10 p-2">
              <Link2 className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{activeCount}</p>
              <p className="text-xs text-muted-foreground">Active Links</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-emerald-500/10 p-2">
              <Eye className="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalViews}</p>
              <p className="text-xs text-muted-foreground">Total Views</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-violet-500/10 p-2">
              <EyeOff className="h-5 w-5 text-violet-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{shares.length - viewedCount}</p>
              <p className="text-xs text-muted-foreground">Not Yet Viewed</p>
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
                <TableHead>Patient</TableHead>
                <TableHead>Portal Link</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Views</TableHead>
                <TableHead>Last Viewed</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead className="w-[140px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shares.map((s) => {
                const status = getShareStatus(s);
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {(s.orthanc_patient_id ?? "").slice(0, 12)}…
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {(s.token ?? "").slice(0, 16)}…
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => copyLink(s)}
                          title="Copy portal link"
                        >
                          {copiedId === s.id ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={`font-medium ${s.view_count > 0 ? "" : "text-muted-foreground"}`}>
                        {s.view_count}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatTimestamp(s.last_viewed_at)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.expires_at ? formatTimestamp(s.expires_at) : (
                        <span className="text-muted-foreground">No expiry</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.created_by_username || "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {s.is_active ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(s)}
                              title="Edit expiry"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => handleRevoke(s.id)}
                              disabled={revoking === s.id}
                              title="Revoke link"
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shares.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    <Share2 className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    No patient portal links created yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create Share Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) setCreateError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Patient Portal Link</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Patient</Label>
              <Select value={selectedPatient} onValueChange={setSelectedPatient}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a patient..." />
                </SelectTrigger>
                <SelectContent>
                  {patients.map((p) => (
                    <SelectItem key={p.ID} value={p.ID}>
                      {formatDicomName(p.MainDicomTags?.PatientName || "")} — {p.MainDicomTags?.PatientID || p.ID.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Link Expiry</Label>
              <div className="flex flex-wrap gap-2">
                {EXPIRY_PRESETS.map((preset) => (
                  <Button
                    key={preset.days}
                    type="button"
                    variant={expiryPreset === String(preset.days) ? "default" : "outline"}
                    size="sm"
                    onClick={() => { setExpiryPreset(String(preset.days)); setCustomExpiry(""); }}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant={expiryPreset === "custom" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setExpiryPreset("custom")}
                >
                  <CalendarClock className="mr-1 h-3 w-3" />
                  Custom
                </Button>
              </div>
              {expiryPreset === "custom" && (
                <Input
                  type="datetime-local"
                  value={customExpiry}
                  onChange={(e) => setCustomExpiry(e.target.value)}
                  className="mt-2"
                />
              )}
            </div>
          </div>
          {createError && <p className="text-sm text-destructive" role="alert">{createError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!selectedPatient || creating}>
              {creating ? "Creating..." : "Create Link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Share Dialog */}
      <Dialog open={!!editShare} onOpenChange={(open) => { if (!open) { setEditShare(null); setEditError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Share Link</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Expiry Date & Time</Label>
              <Input
                type="datetime-local"
                value={editExpiry}
                onChange={(e) => setEditExpiry(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for no expiry. Current: {editShare?.expires_at ? formatTimestamp(editShare.expires_at) : "No expiry"}
              </p>
            </div>
          </div>
          {editError && <p className="text-sm text-destructive" role="alert">{editError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditShare(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
