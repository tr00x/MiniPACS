import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TableSkeleton } from "@/components/TableSkeleton";
import { Copy, Check, Ban, Share2, Plus, Pencil, CalendarClock, ChevronLeft, ChevronRight, Search, ExternalLink, Printer } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import api from "@/lib/api";
import { formatDicomName, formatTimestamp, getShareStatus, EXPIRY_PRESETS } from "@/lib/dicom";

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

const PAGE_SIZE = 50;

function buildPortalUrl(token: string) {
  return `${window.location.origin}/patient-portal/${token}`;
}

export function SharesPage() {
  const [shares, setShares] = useState<Share[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Search + pagination
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Revoke confirm
  const [revokeTarget, setRevokeTarget] = useState<number | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState("");
  const [expiryPreset, setExpiryPreset] = useState("30");
  const [customExpiry, setCustomExpiry] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Success dialog — shows link after creation
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [createdLinkCopied, setCreatedLinkCopied] = useState(false);

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
    api.get("/patients", { params: { limit: 100 }, signal: ctrl.signal })
      .then(({ data }) => setPatients(data.items ?? data))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => { setPage(1); }, [search]);

  const getPatientName = (orthanc_patient_id: string) => {
    const p = patients.find((pt) => pt.ID === orthanc_patient_id);
    return p ? formatDicomName(p.MainDicomTags?.PatientName || "") : null;
  };

  const filtered = shares.filter((s) => {
    if (!search.trim()) return true;
    const name = getPatientName(s.orthanc_patient_id) ?? s.orthanc_patient_id;
    return name.toLowerCase().includes(search.toLowerCase());
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleRevokeConfirm = async () => {
    if (revokeTarget === null) return;
    setRevoking(true);
    try {
      await api.delete(`/shares/${revokeTarget}`);
      setRevokeTarget(null);
      toast.success("Share link revoked");
      fetchShares();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to revoke share");
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
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
      const { data } = await api.post("/shares", {
        orthanc_patient_id: selectedPatient,
        expires_at,
      });
      setCreateOpen(false);
      setSelectedPatient("");
      setExpiryPreset("30");
      setCustomExpiry("");
      // Show success dialog with the link
      const url = buildPortalUrl(data.token);
      setCreatedLink(url);
      setCreatedLinkCopied(false);
      // Auto-copy to clipboard
      navigator.clipboard.writeText(url);
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
      toast.success("Share link updated");
      fetchShares();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setEditError(e?.response?.data?.detail ?? e?.message ?? "Failed to update share");
    } finally {
      setSaving(false);
    }
  };

  const copyLink = (share: Share) => {
    const url = buildPortalUrl(share.token);
    navigator.clipboard.writeText(url);
    setCopiedId(share.id);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const copyCreatedLink = () => {
    if (!createdLink) return;
    navigator.clipboard.writeText(createdLink);
    setCreatedLinkCopied(true);
    toast.success("Link copied to clipboard");
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Patient Shares</h2>
          <p className="text-sm text-muted-foreground">{shares.length} portal links</p>
        </div>
        <Button onClick={() => { setCreateOpen(true); setCreateError(null); }}>
          <Plus className="mr-2 h-4 w-4" />
          Create Share Link
        </Button>
      </div>

      <div className="relative w-full max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by patient name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="rounded-lg border"><TableSkeleton columns={6} /></div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Patient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[200px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.map((s) => {
                  const status = getShareStatus(s);
                  const patientName = getPatientName(s.orthanc_patient_id) ?? ((s.orthanc_patient_id ?? "").slice(0, 12) + "…");
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link to={`/patients/${s.orthanc_patient_id}`} className="text-primary hover:underline text-sm font-medium">
                          {patientName}
                        </Link>
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
                        {s.expires_at ? formatTimestamp(s.expires_at) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatTimestamp(s.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={() => copyLink(s)}
                          >
                            {copiedId === s.id ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            {copiedId === s.id ? "Copied!" : "Copy Link"}
                          </Button>
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
                                onClick={() => setRevokeTarget(s.id)}
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
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      <Share2 className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      {search ? "No matching shares found" : "No patient portal links created yet"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Showing {Math.min((page - 1) * PAGE_SIZE + 1, filtered.length)}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                  <ChevronLeft className="h-4 w-4" /> Prev
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title="Revoke Share Link"
        description="This will permanently disable this patient portal link. The patient will no longer be able to access their records through this link."
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevokeConfirm}
        loading={revoking}
      />

      {/* Create Share Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) setCreateError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Patient Portal Link</DialogTitle>
            <DialogDescription>
              Generate a secure link for a patient to view and download their imaging studies.
            </DialogDescription>
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

      {/* Success Dialog — shows link + QR code after creation */}
      <Dialog open={!!createdLink} onOpenChange={(open) => { if (!open) setCreatedLink(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Portal Link Created</DialogTitle>
            <DialogDescription>
              The link has been automatically copied to your clipboard. Send it to the patient via email, text, or let them scan the QR code.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {createdLink && (
              <div className="qr-print-source flex justify-center rounded-lg border bg-white p-4">
                <QRCodeSVG value={createdLink} size={160} />
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={createdLink || ""}
                className="font-mono text-sm"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <Button variant="outline" size="icon" className="shrink-0" onClick={copyCreatedLink}>
                {createdLinkCopied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={copyCreatedLink}>
                <Copy className="mr-2 h-4 w-4" />
                {createdLinkCopied ? "Copied!" : "Copy Link"}
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => {
                if (createdLink) window.open(createdLink, "_blank");
              }}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Open in Browser
              </Button>
            </div>
            <Button variant="outline" className="w-full" onClick={() => {
              if (!createdLink) return;
              const win = window.open("", "_blank", "width=400,height=500");
              if (!win) return;
              win.document.write(`<!DOCTYPE html><html><head><title>Patient Portal QR Code</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui,sans-serif}p{margin-top:16px;font-size:12px;color:#666;max-width:300px;word-break:break-all;text-align:center}</style></head><body></body></html>`);
              const container = win.document.body;
              const svg = document.querySelector<SVGElement>(".qr-print-source svg");
              if (svg) {
                const clone = svg.cloneNode(true) as SVGElement;
                clone.setAttribute("width", "256");
                clone.setAttribute("height", "256");
                container.appendChild(clone);
              }
              const urlP = win.document.createElement("p");
              urlP.textContent = createdLink;
              container.appendChild(urlP);
              win.document.close();
              win.focus();
              win.print();
            }}>
              <Printer className="mr-2 h-4 w-4" />
              Print QR Code
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreatedLink(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Share Dialog */}
      <Dialog open={!!editShare} onOpenChange={(open) => { if (!open) { setEditShare(null); setEditError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Share Link</DialogTitle>
            <DialogDescription>
              Change when this portal link expires. The patient will lose access after the expiry date.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {editShare && (
              <div className="rounded-md bg-muted p-3 space-y-1">
                <p className="text-sm font-medium">
                  {getPatientName(editShare.orthanc_patient_id) || "Patient"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Created {formatTimestamp(editShare.created_at)} · {editShare.view_count} views
                </p>
              </div>
            )}
            <div className="grid gap-2">
              <Label>Expiry Date & Time</Label>
              <Input
                type="datetime-local"
                value={editExpiry}
                onChange={(e) => setEditExpiry(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for no expiry.
                {editShare?.expires_at ? ` Currently expires: ${formatTimestamp(editShare.expires_at)}` : " Currently: no expiry."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={editShare ? buildPortalUrl(editShare.token) : ""}
                className="font-mono text-xs"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <Button variant="outline" size="icon" className="shrink-0" onClick={() => {
                if (editShare) {
                  navigator.clipboard.writeText(buildPortalUrl(editShare.token));
                  toast.success("Link copied to clipboard");
                }
              }}>
                <Copy className="h-4 w-4" />
              </Button>
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
