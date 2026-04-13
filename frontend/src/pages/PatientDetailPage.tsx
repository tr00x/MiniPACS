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
import { Eye, FileImage, Share2, ArrowLeft, Copy, Check, Plus, Pencil, Ban, ArrowRightLeft, ChevronDown, Lock, Shuffle, Mail, Download } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
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
  pin_hash?: string | null;
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

  // Share dialog — 3-step flow
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareStep, setShareStep] = useState<"config" | "result">("config");
  const [shareLink, setShareLink] = useState("");
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [shareExpiry, setShareExpiry] = useState(30);
  const [sharePin, setSharePin] = useState("");
  const [creatingShare, setCreatingShare] = useState(false);
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

  const openShareDialog = () => {
    setShareLink("");
    setShareLinkCopied(false);
    setShareExpiry(30);
    setSharePin("");
    setShareStep("config");
    setShareDialogOpen(true);
  };

  const handleShareCreate = async () => {
    if (!id) return;
    setCreatingShare(true);
    try {
      const expiresAt = shareExpiry > 0
        ? new Date(Date.now() + shareExpiry * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const { data } = await api.post("/shares", {
        orthanc_patient_id: id,
        expires_at: expiresAt,
        pin: sharePin || undefined,
      });
      const token = data?.token ?? data?.share_token ?? data?.id ?? "";
      setShareLink(token ? `${window.location.origin}/patient-portal/${token}` : "");
      setShareStep("result");
      // Refresh shares list
      const sharesRes = await api.get("/shares", { params: { patient_id: id } });
      setShares(sharesRes.data.items ?? sharesRes.data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      toast.error(e?.response?.data?.detail ?? e?.message ?? "Failed to create share");
    } finally {
      setCreatingShare(false);
    }
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(shareLink);
    setShareLinkCopied(true);
    setTimeout(() => setShareLinkCopied(false), 2000);
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

      {/* Share Dialog — 3-step flow */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Share with Patient</DialogTitle>
          </DialogHeader>

                    {shareStep === "config" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Create a patient portal link for viewing and downloading imaging studies.
              </p>

              {/* Expiry selection */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Link Expiry</label>
                <div className="flex flex-wrap gap-2">
                  {EXPIRY_PRESETS.map((p) => (
                    <Button
                      key={p.days}
                      variant={shareExpiry === p.days ? "default" : "outline"}
                      size="sm"
                      onClick={() => setShareExpiry(p.days)}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Optional PIN */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5" />
                  PIN Protection (optional)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="4-6 digit PIN"
                    value={sharePin}
                    onChange={(e) => setSharePin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="flex h-9 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 shrink-0"
                    onClick={() => setSharePin(String(Math.floor(1000 + Math.random() * 9000)))}
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                    Random
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  If set, the patient must enter this PIN to access their records.
                </p>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setShareDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleShareCreate} disabled={creatingShare} className="gap-2">
                  <Share2 className="h-4 w-4" />
                  {creatingShare ? "Creating..." : "Create Link"}
                </Button>
              </DialogFooter>
            </div>
          )}

          {shareStep === "result" && (
            <div className="space-y-4">
              {/* QR Code + download */}
              {shareLink && (
                <div className="flex flex-col items-center gap-3 py-2">
                  <div id="share-qr-patient" className="rounded-lg border bg-white p-4">
                    <QRCodeSVG value={shareLink} size={180} />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      const svg = document.querySelector("#share-qr-patient svg");
                      if (!svg) return;
                      const canvas = document.createElement("canvas");
                      canvas.width = 256;
                      canvas.height = 256;
                      const ctx = canvas.getContext("2d");
                      if (!ctx) return;
                      ctx.fillStyle = "white";
                      ctx.fillRect(0, 0, 256, 256);
                      const img = new Image();
                      const svgData = new XMLSerializer().serializeToString(svg);
                      img.onload = () => {
                        ctx.drawImage(img, 28, 28, 200, 200);
                        const a = document.createElement("a");
                        a.download = "patient-portal-qr.png";
                        a.href = canvas.toDataURL("image/png");
                        a.click();
                      };
                      img.src = "data:image/svg+xml;base64," + btoa(svgData);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Save QR Code
                  </Button>
                </div>
              )}

              {/* Link with copy */}
              <div className="rounded-md bg-muted p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Portal Link</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs break-all rounded bg-background p-2 border min-w-0">
                    {shareLink}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyShareLink} className="shrink-0 w-[72px] gap-1.5">
                    {shareLinkCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {shareLinkCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>

              {/* Info */}
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200 space-y-1">
                <p>
                  {shareExpiry > 0 ? `Expires in ${shareExpiry} days.` : "No expiration set."}
                  {sharePin ? ` PIN: ${sharePin}` : " No PIN protection."}
                </p>
                <p>Patient can view studies online and download DICOM files.</p>
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                {/* Email to Patient */}
                <Button
                  variant="outline"
                  className="gap-1.5 flex-1"
                  onClick={() => {
                    const patientName = formatDicomName(ptag("PatientName")).split(" ")[0];
                    const expiryText = shareExpiry > 0
                      ? `This link will expire in ${shareExpiry} days.`
                      : "This link does not expire.";
                    const pinText = sharePin
                      ? `\n\nYou will need the following PIN to access your records: ${sharePin}`
                      : "";

                    const subject = encodeURIComponent(`Your Imaging Records — ${formatDicomName(ptag("PatientName"))}`);
                    const body = encodeURIComponent(
`Dear ${patientName},

Your imaging records are now available for viewing and download through our secure patient portal.

Click the link below to access your records:
${shareLink}
${pinText}

${expiryText}

What you can do:
\u2022 View your images online in our DICOM viewer
\u2022 Download your images as a ZIP file for your records
\u2022 Share this link with another physician if needed

If you have any questions about your results, please contact our office.

Best regards,
Clinton Medical`
                    );
                    window.open(`mailto:?subject=${subject}&body=${body}`, "_self");
                  }}
                >
                  <Mail className="h-4 w-4" />
                  Email to Patient
                </Button>
                <Button onClick={() => setShareDialogOpen(false)} className="flex-1">Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Share Dialog */}
      <Dialog open={!!editShare} onOpenChange={(open) => { if (!open) { setEditShare(null); setEditShareError(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Share Link</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            {/* Current status */}
            <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={editShare?.is_active ? "default" : "secondary"}>
                  {editShare?.is_active ? "Active" : "Revoked"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Current expiry</span>
                <span className="font-medium">{editShare?.expires_at ? formatTimestamp(editShare.expires_at) : "No expiry"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Views</span>
                <span className="font-medium">{editShare?.view_count || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">PIN</span>
                <span className="font-medium text-xs">
                  {editShare?.pin_hash
                    ? <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Protected</span>
                    : "Not set"}
                </span>
              </div>
            </div>

            {/* New expiry */}
            <div className="space-y-2">
              <Label>New Expiry Date</Label>
              <Input
                type="date"
                value={editExpiry ? editExpiry.slice(0, 10) : ""}
                onChange={(e) => setEditExpiry(e.target.value ? `${e.target.value}T23:59` : "")}
              />
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-muted-foreground">
                  {editExpiry
                    ? `Expires: ${new Date(editExpiry).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`
                    : "No expiry — link will remain active indefinitely"}
                </p>
                {editExpiry && (
                  <Button type="button" variant="ghost" size="sm" className="text-xs h-6" onClick={() => setEditExpiry("")}>
                    Remove expiry
                  </Button>
                )}
              </div>
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
          <Button size="sm" onClick={openShareDialog}>
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
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {s.view_count > 0 ? `${s.view_count} views` : "Not viewed"}
                        </span>
                        {s.pin_hash && (
                          <span className="text-xs text-muted-foreground flex items-center gap-0.5" title="PIN protected">
                            <Lock className="h-3 w-3" />
                            <span>PIN protected</span>
                          </span>
                        )}
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
