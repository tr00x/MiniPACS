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
import { Eye, FileImage, Share2, ArrowLeft, Copy, Check, Plus, Pencil, Ban, CalendarClock, ArrowRightLeft } from "lucide-react";
import api from "@/lib/api";
import { PageLoader } from "@/components/PageLoader";
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
        setTransfers(transferResults.flatMap((r) => r.data));
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
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {formatDicomName(ptag("PatientName"))}
          </h2>
          <p className="text-sm text-muted-foreground">
            MRN: {ptag("PatientID")}
            {rawBirth ? ` · ${formatDicomDate(rawBirth)} (${calculateAge(rawBirth)})` : ""}
            {sex ? ` · ${sex === "M" ? "Male" : sex === "F" ? "Female" : sex}` : ""}
          </p>
        </div>
      </div>

      {/* Demographics card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Demographics</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Medical Record #</dt>
              <dd className="mt-1 font-mono">{ptag("PatientID") || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Date of Birth</dt>
              <dd className="mt-1">{formatDicomDate(rawBirth)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Age</dt>
              <dd className="mt-1">{calculateAge(rawBirth) || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sex</dt>
              <dd className="mt-1">
                <Badge variant="outline">
                  {sex === "M" ? "Male" : sex === "F" ? "Female" : sex || "—"}
                </Badge>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

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
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead>Modality</TableHead>
                  <TableHead>Accession #</TableHead>
                  <TableHead className="w-[80px]">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {studies.map((s) => (
                  <TableRow key={s.ID} className="hover:bg-accent/50">
                    <TableCell className="font-medium">
                      {formatDicomDate(stag(s, "StudyDate"))}
                    </TableCell>
                    <TableCell>{stag(s, "StudyDescription") || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {stag(s, "InstitutionName") || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {stag(s, "ModalitiesInStudy") || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {stag(s, "AccessionNumber") ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {stag(s, "AccessionNumber")}
                        </code>
                      ) : "—"}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" asChild>
                        <Link to={`/studies/${s.ID}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {studies.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-16 text-center text-muted-foreground">
                      No imaging studies on file
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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

      {/* Transfer History */}
      {transfers.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">
                Transfer History ({transfers.length})
              </CardTitle>
            </div>
          </CardHeader>
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
                        <TableCell className="text-sm">{t.pacs_node_name || "—"}</TableCell>
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
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>Token</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Views</TableHead>
                    <TableHead>First Viewed</TableHead>
                    <TableHead>Last Viewed</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shares.map((s) => {
                    const status = getShareStatus(s);
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {(s.token ?? "").slice(0, 12)}…
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => copyToken(s.id, s.token)}
                            >
                              {copiedToken === s.id ? (
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
                        <TableCell>
                          <span className="font-medium">{s.view_count}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(s.first_viewed_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(s.last_viewed_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(s.created_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {s.expires_at ? formatTimestamp(s.expires_at) : "No expiry"}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {s.is_active && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => { setEditShare(s); setEditExpiry(s.expires_at ? s.expires_at.slice(0, 16) : ""); setEditShareError(null); }}
                                  title="Edit expiry"
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => handleRevokeShare(s.id)}
                                  disabled={revokingShare === s.id}
                                  title="Revoke link"
                                >
                                  <Ban className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
