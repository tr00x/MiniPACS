import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, FileImage, Share2, ArrowLeft, Copy, Check, Plus, Pencil, Ban, CalendarClock, ArrowRightLeft, ChevronDown } from "lucide-react";
import api from "@/lib/api";
import { PageLoader } from "@/components/PageLoader";
import { ModalityBadgeList } from "@/components/ui/modality-badge";
import { formatDicomName, formatDicomDate, formatTimestamp, calculateAge, getShareStatus, EXPIRY_PRESETS } from "@/lib/dicom";

interface PatientData {
  MainDicomTags: {
    PatientID?: string;
    PatientName?: string;
    PatientBirthDate?: string;
    PatientSex?: string;
  };
}

interface Study {
  ID: string;
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
    StudyInstanceUID?: string;
    InstitutionName?: string;
  };
}

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
}

interface Transfer {
  id: number;
  orthanc_study_id: string;
  pacs_node_name: string | null;
  status: string;
  created_at: string;
}

export function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<PatientData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<number | null>(null);

  // Share management
  const [createShareOpen, setCreateShareOpen] = useState(false);
  const [expiryPreset, setExpiryPreset] = useState("30");
  const [customExpiry, setCustomExpiry] = useState("");
  const [creatingShare, setCreatingShare] = useState(false);
  const [createShareError, setCreateShareError] = useState<string | null>(null);
  const [editShare, setEditShare] = useState<Share | null>(null);
  const [editExpiry, setEditExpiry] = useState("");
  const [savingShare, setSavingShare] = useState(false);
  const [editShareError, setEditShareError] = useState<string | null>(null);
  const [revokingShare, setRevokingShare] = useState<number | null>(null);
  const [transfersOpen, setTransfersOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      api.get(`/patients/${id}`, { signal: ctrl.signal }),
      api.get("/shares", { params: { patient_id: id }, signal: ctrl.signal }),
    ])
      .then(async ([patientRes, sharesRes]) => {
        setPatient(patientRes.data.patient);
        const patientStudies: Study[] = patientRes.data.studies;
        setStudies(patientStudies);
        setShares(sharesRes.data);
        const studyIds = patientStudies.map((s: Study) => s.ID);
        const transferResults = await Promise.all(
          studyIds.map((sid: string) =>
            api.get("/transfers", { params: { study_id: sid }, signal: ctrl.signal })
              .catch(() => ({ data: [] }))
          )
        );
        setTransfers(transferResults.flatMap((r) => r.data.items ?? r.data));
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load patient");
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [id]);

  if (!id) {
    return <p className="text-muted-foreground">Invalid patient ID</p>;
  }

  const ptag = (key: keyof PatientData["MainDicomTags"]) =>
    patient?.MainDicomTags?.[key] || "";

  const stag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  const copyToken = (shareId: number, token: string) => {
    const url = `${window.location.origin}/patient-portal/${token}`;
    navigator.clipboard.writeText(url);
    setCopiedToken(shareId);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const handleCreateShare = async () => {
    if (!id) return;
    setCreatingShare(true);
    setCreateShareError(null);
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
      const { data } = await api.post("/shares", { orthanc_patient_id: id, expires_at });
      setShares([data, ...shares]);
      setCreateShareOpen(false);
      setExpiryPreset("30");
      setCustomExpiry("");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setCreateShareError(e?.response?.data?.detail ?? e?.message ?? "Failed to create share");
    } finally {
      setCreatingShare(false);
    }
  };

  const handleEditShare = async () => {
    if (!editShare) return;
    setSavingShare(true);
    setEditShareError(null);
    try {
      await api.put(`/shares/${editShare.id}`, {
        expires_at: editExpiry ? new Date(editExpiry).toISOString() : null,
      });
      setShares(shares.map((s) => s.id === editShare.id ? { ...s, expires_at: editExpiry ? new Date(editExpiry).toISOString() : null } : s));
      setEditShare(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setEditShareError(e?.response?.data?.detail ?? e?.message ?? "Failed to update share");
    } finally {
      setSavingShare(false);
    }
  };

  const handleRevokeShare = async (shareId: number) => {
    setRevokingShare(shareId);
    try {
      await api.delete(`/shares/${shareId}`);
      setShares(shares.map((s) => s.id === shareId ? { ...s, is_active: 0 } : s));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to revoke share");
    } finally {
      setRevokingShare(null);
    }
  };

  if (loading) {
    return <PageLoader />;
  }

  if (error) {
    return <p className="text-destructive" role="alert">Error: {error}</p>;
  }

  if (!patient) {
    return <p className="text-muted-foreground">Patient not found</p>;
  }

  const rawBirth = ptag("PatientBirthDate");
  const sex = ptag("PatientSex");

  return (
    <div className="space-y-6">
      {/* Header with back button */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/patients">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h2 className="text-2xl font-semibold tracking-tight">
          {formatDicomName(ptag("PatientName"))}
        </h2>
      </div>

      {/* Demographics — compact inline row */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm rounded-lg border bg-muted/30 p-4">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">MRN</span>
          <span className="font-mono font-medium">{ptag("PatientID")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">DOB</span>
          <span className="font-medium">{formatDicomDate(rawBirth)}</span>
          {rawBirth && <span className="text-xs text-muted-foreground">({calculateAge(rawBirth)})</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {sex === "M" && <span className="text-blue-500">&#9794;</span>}
          {sex === "F" && <span className="text-pink-500">&#9792;</span>}
          <span className="font-medium">{sex === "M" ? "Male" : sex === "F" ? "Female" : sex || "\u2014"}</span>
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <FileImage className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-semibold">{studies.length} studies</span>
        </div>
      </div>

      {/* Studies */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <FileImage className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Studies ({studies.length})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {studies.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No imaging studies on file
            </p>
          ) : (
            <div className="space-y-2">
              {studies.map((s) => {
                const mod = stag(s, "ModalitiesInStudy");
                return (
                  <div key={s.ID} className="flex items-center justify-between gap-4 rounded-lg border p-4 hover:bg-accent/30 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {mod && <ModalityBadgeList modalities={mod.replace(/\\/g, "/").split("/")} />}
                        <span className="font-medium truncate">{stag(s, "StudyDescription") || "Untitled Study"}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{formatDicomDate(stag(s, "StudyDate"))}</span>
                        {stag(s, "InstitutionName") && <span>{stag(s, "InstitutionName")}</span>}
                        {stag(s, "AccessionNumber") && <span className="font-mono">Acc# {stag(s, "AccessionNumber")}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button variant="ghost" size="sm" asChild className="gap-1">
                        <Link to={`/studies/${s.ID}`}><Eye className="h-3.5 w-3.5" /> View</Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Share Dialog */}
      <Dialog open={createShareOpen} onOpenChange={(open) => { setCreateShareOpen(open); if (!open) setCreateShareError(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Patient Portal Link</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
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
                <Input type="datetime-local" value={customExpiry} onChange={(e) => setCustomExpiry(e.target.value)} className="mt-2" />
              )}
            </div>
          </div>
          {createShareError && <p className="text-sm text-destructive" role="alert">{createShareError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateShareOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateShare} disabled={creatingShare}>
              {creatingShare ? "Creating..." : "Create Link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Share Dialog */}
      <Dialog open={!!editShare} onOpenChange={(open) => { if (!open) { setEditShare(null); setEditShareError(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Share Link</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Expiry Date & Time</Label>
              <Input type="datetime-local" value={editExpiry} onChange={(e) => setEditExpiry(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Leave empty for no expiry. Current: {editShare?.expires_at ? formatTimestamp(editShare.expires_at) : "No expiry"}
              </p>
            </div>
          </div>
          {editShareError && <p className="text-sm text-destructive" role="alert">{editShareError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditShare(null)}>Cancel</Button>
            <Button onClick={handleEditShare} disabled={savingShare}>
              {savingShare ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer History — collapsible */}
      {transfers.length > 0 && (
        <Card>
          <CardHeader
            className="cursor-pointer select-none hover:bg-accent/30 transition-colors"
            onClick={() => setTransfersOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">
                Transfer History ({transfers.length})
              </CardTitle>
              <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${transfersOpen ? "rotate-180" : ""}`} />
            </div>
          </CardHeader>
          {transfersOpen && (
            <CardContent>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Study</TableHead>
                      <TableHead>Destination</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transfers.map((t) => {
                      const study = studies.find((s) => s.ID === t.orthanc_study_id);
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="text-sm">
                            {study ? (study.MainDicomTags?.StudyDescription || "Untitled") : t.orthanc_study_id.slice(0, 12)}
                          </TableCell>
                          <TableCell className="text-sm">{t.pacs_node_name || "\u2014"}</TableCell>
                          <TableCell>
                            <Badge variant={t.status === "success" ? "default" : t.status === "failed" ? "destructive" : "secondary"}>
                              {t.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{formatTimestamp(t.created_at)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Shares */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Patient Portal Links ({shares.length})
            </CardTitle>
          </div>
          <Button size="sm" onClick={() => { setCreateShareOpen(true); setCreateShareError(null); }}>
            <Plus className="mr-1 h-4 w-4" /> Create Link
          </Button>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No portal links shared with this patient
            </p>
          ) : (
            <div className="space-y-2">
              {shares.map((s) => {
                const status = getShareStatus(s);
                return (
                  <div key={s.id} className="flex items-center justify-between gap-4 rounded-lg border p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {s.view_count > 0 ? `${s.view_count} views` : "Not viewed"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>Created {formatTimestamp(s.created_at)}</span>
                        <span>{s.expires_at ? `Expires ${formatTimestamp(s.expires_at)}` : "No expiry"}</span>
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => copyToken(s.id, s.token)} title="Copy link">
                        {copiedToken === s.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      {s.is_active ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => { setEditShare(s); setEditExpiry(s.expires_at ? s.expires_at.slice(0, 16) : ""); setEditShareError(null); }}
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => handleRevokeShare(s.id)}
                            disabled={revokingShare === s.id}
                            title="Revoke"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
