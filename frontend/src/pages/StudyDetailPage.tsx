import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Download, Send, ExternalLink, ArrowLeft, Info, Copy, Check, Share2, Maximize, Minimize, Layers, Lock, Shuffle, Mail } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { EXPIRY_PRESETS } from "@/lib/dicom";
import { OhifViewer } from "@/components/viewer/OhifViewer";
import { ModalityBadge } from "@/components/ui/modality-badge";
import api, { getErrorMessage } from "@/lib/api";
import { PageLoader } from "@/components/PageLoader";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";
import { toast } from "sonner";

interface StudyData {
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
    StudyInstanceUID?: string;
    InstitutionName?: string;
    ReferringPhysicianName?: string;
  };
  PatientMainDicomTags?: {
    PatientName?: string;
    PatientID?: string;
  };
  ParentPatient?: string;
}

interface Series {
  ID: string;
  MainDicomTags: {
    SeriesDescription?: string;
    Modality?: string;
    SeriesNumber?: string;
    NumberOfSeriesRelatedInstances?: string;
    Manufacturer?: string;
  };
  Instances?: string[];
}

interface PacsNode {
  id: number;
  name: string;
  ae_title: string;
}

interface Viewer {
  id: number;
  name: string;
  url_scheme: string;
  is_enabled: boolean;
}

export function StudyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const [study, setStudy] = useState<StudyData | null>(null);
  const [series, setSeries] = useState<Series[]>([]);
  const [pacsNodes, setPacsNodes] = useState<PacsNode[]>([]);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [uidCopied, setUidCopied] = useState(false);
  const [sendStatus, setSendStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [showMetadata, setShowMetadata] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Share dialog
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareStep, setShareStep] = useState<"config" | "result">("config");
  const [shareLink, setShareLink] = useState("");
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [shareExpiry, setShareExpiry] = useState(30); // days
  const [sharePin, setSharePin] = useState("");
  // Download dialog
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      api.get(`/studies/${id}`, { signal: ctrl.signal }),
      api.get("/pacs-nodes", { signal: ctrl.signal }),
      api.get("/viewers", { signal: ctrl.signal }),
    ])
      .then(([studyRes, nodesRes, viewersRes]) => {
        setStudy(studyRes.data.study);
        setSeries(studyRes.data.series);
        setPacsNodes(nodesRes.data);
        setViewers(viewersRes.data.filter((v: Viewer) => v.is_enabled));
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load study");
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [id]);

  // Listen for fullscreen changes (user pressing Esc)
  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  if (!id) return <p className="text-muted-foreground">Invalid study ID</p>;

  const stag = (key: keyof StudyData["MainDicomTags"]) => study?.MainDicomTags?.[key] || "";
  const ptag = (key: keyof NonNullable<StudyData["PatientMainDicomTags"]>) => study?.PatientMainDicomTags?.[key] || "";

  const toggleFullscreen = async () => {
    if (!viewerContainerRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await viewerContainerRef.current.requestFullscreen();
    }
  };

  const handleSend = async () => {
    if (!selectedNode) return;
    setSending(true);
    setSendError(null);
    setSendStatus("sending");
    try {
      const { data } = await api.post("/transfers", { study_id: id, pacs_node_id: Number(selectedNode) });
      if (data.status === "failed") {
        const raw = data.error_message || "";
        let userMsg = "The destination PACS could not be reached.";
        if (raw.includes("not found")) userMsg = "This PACS node is not registered. Try removing and re-adding it.";
        else if (raw.includes("timeout")) userMsg = "Connection timed out. The destination may be offline.";
        else if (raw.includes("refused")) userMsg = "Connection refused.";
        setSendError(userMsg + (raw ? `\n\nTechnical details: ${raw}` : ""));
        setSendStatus("error");
      } else {
        setSendStatus("success");
      }
    } catch (err: unknown) {
      setSendError(getErrorMessage(err, "Failed to send study"));
      setSendStatus("error");
    } finally {
      setSending(false);
    }
  };

  const closeSendDialog = () => {
    setSendDialogOpen(false);
    setSendError(null);
    setSelectedNode("");
    setSendStatus("idle");
  };

  // handleDownload removed — replaced by handleDownloadConfirm with dialog

  const openShareDialog = () => {
    setShareStep("config");
    setShareLink("");
    setShareLinkCopied(false);
    setShareExpiry(30);
    setSharePin("");
    setShareDialogOpen(true);
  };

  const handleShareCreate = async () => {
    if (!study?.ParentPatient) return;
    setSharing(true);
    try {
      const expiresAt = shareExpiry > 0
        ? new Date(Date.now() + shareExpiry * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const res = await api.post("/shares", {
        orthanc_patient_id: study.ParentPatient,
        expires_at: expiresAt,
        pin: sharePin || undefined,
      });
      const token = res.data?.token ?? res.data?.share_token ?? res.data?.id ?? "";
      const portalLink = token ? `${window.location.origin}/patient-portal/${token}` : "";
      setShareLink(portalLink);
      setShareStep("result");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create share"));
    } finally {
      setSharing(false);
    }
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(shareLink);
    setShareLinkCopied(true);
    setTimeout(() => setShareLinkCopied(false), 2000);
  };

  const handleDownloadConfirm = async () => {
    setDownloadDialogOpen(false);
    setDownloading(true);
    try {
      const res = await api.get(`/studies/${id}/download`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `study-${id}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Download started");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to download study"));
    } finally {
      setDownloading(false);
    }
  };

  const copyUid = () => {
    navigator.clipboard.writeText(studyUid);
    setUidCopied(true);
    setTimeout(() => setUidCopied(false), 2000);
  };

  const studyUid = stag("StudyInstanceUID");

  if (loading) return <PageLoader />;
  if (error) return <p className="text-destructive" role="alert">Error: {error}</p>;
  if (!study) return <p className="text-muted-foreground">Study not found</p>;

  const modality = stag("ModalitiesInStudy");
  const totalInstances = series.reduce(
    (sum, s) => sum + parseInt(s.MainDicomTags?.NumberOfSeriesRelatedInstances || "0", 10), 0
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-semibold tracking-tight truncate">
                  {stag("StudyDescription") || "Untitled Study"}
                </h2>
                {modality && modality.replace(/\\/g, "/").split("/").map((m) => (
                  <ModalityBadge key={m} modality={m} />
                ))}
                <span className="text-sm text-muted-foreground">
                  {formatDicomDate(stag("StudyDate"))}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {study?.ParentPatient ? (
                  <Link to={`/patients/${study.ParentPatient}`} className="text-primary hover:underline">
                    {formatDicomName(ptag("PatientName"))}
                  </Link>
                ) : formatDicomName(ptag("PatientName"))}
                {ptag("PatientID") && (
                  <> · MRN: <span className="font-medical-id">{ptag("PatientID")}</span></>
                )}
                {stag("InstitutionName") && <> · {stag("InstitutionName")}</>}
              </p>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 shrink-0 flex-wrap justify-end">
          <Button size="lg" onClick={toggleFullscreen} className="gap-2">
            <Maximize className="h-4 w-4" />
            Fullscreen
          </Button>
          <Button variant="outline" onClick={() => window.open(`/ohif/viewer?StudyInstanceUIDs=${studyUid}`, '_blank')} className="gap-2">
            <ExternalLink className="h-4 w-4" />
            New Tab
          </Button>
          <Button variant="outline" onClick={() => setSendDialogOpen(true)} className="gap-2">
            <Send className="h-4 w-4" />
            Send to PACS
          </Button>
          {study?.ParentPatient && (
            <Button variant="outline" onClick={openShareDialog} className="gap-2">
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          )}
          <Button variant="outline" onClick={() => setDownloadDialogOpen(true)} disabled={downloading} className="gap-2">
            <Download className="h-4 w-4" />
            {downloading ? "Downloading..." : "Download"}
          </Button>
          {viewers.map((v) => (
            <Button
              key={v.id}
              variant="outline"
              className="gap-2"
              onClick={() => {
                const url = (v.url_scheme ?? "")
                  .replace("{StudyInstanceUID}", studyUid)
                  .replace("{study_id}", id);
                window.open(url, "_blank");
              }}
            >
              <ExternalLink className="h-4 w-4" />
              {v.name}
            </Button>
          ))}
        </div>
      </div>

      {/* DICOM Viewer */}
      {studyUid && (
        <div ref={viewerContainerRef} className="rounded-lg border bg-black overflow-hidden">
          <OhifViewer studyInstanceUID={studyUid} className={isFullscreen ? "h-screen w-full" : "h-[600px] w-full"} />
        </div>
      )}

      {/* Series info blocks */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              {series.length} Series · {totalInstances} images
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {series.map((s) => {
              const imgCount = s.MainDicomTags?.NumberOfSeriesRelatedInstances || "0";
              return (
                <div key={s.ID} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/30 transition-colors">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    <span className="text-sm font-bold text-muted-foreground">#{s.MainDicomTags?.SeriesNumber || "?"}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {s.MainDicomTags?.SeriesDescription || "Untitled Series"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.MainDicomTags?.Manufacturer || ""} · {imgCount} images
                    </p>
                  </div>
                  <ModalityBadge modality={s.MainDicomTags?.Modality || "OT"} />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Study Metadata (collapsed by default) */}
      <Card>
        <CardHeader className="cursor-pointer select-none pb-3" onClick={() => setShowMetadata(!showMetadata)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Study Information</CardTitle>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
              {showMetadata ? "Hide" : "Show details"}
            </Button>
          </div>
        </CardHeader>
        {showMetadata && (
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm md:grid-cols-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Patient</dt>
                <dd className="mt-1 font-medium">
                  {study?.ParentPatient ? (
                    <Link to={`/patients/${study.ParentPatient}`} className="text-primary hover:underline">
                      {formatDicomName(ptag("PatientName"))}
                    </Link>
                  ) : formatDicomName(ptag("PatientName"))}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Medical Record #</dt>
                <dd className="mt-1">
                  <code className="font-medical-id rounded bg-muted px-1.5 py-0.5 text-xs">{ptag("PatientID") || "—"}</code>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Study Date</dt>
                <dd className="mt-1">{formatDicomDate(stag("StudyDate"))}</dd>
              </div>
              {stag("InstitutionName") && (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Institution</dt>
                  <dd className="mt-1">{stag("InstitutionName")}</dd>
                </div>
              )}
              {stag("ReferringPhysicianName") && (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Referring Physician</dt>
                  <dd className="mt-1">{formatDicomName(stag("ReferringPhysicianName"))}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Accession #</dt>
                <dd className="mt-1">
                  {stag("AccessionNumber") ? (
                    <code className="font-medical-id rounded bg-muted px-1.5 py-0.5 text-xs">{stag("AccessionNumber")}</code>
                  ) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Study UID</dt>
                <dd className="mt-1 flex items-center gap-1">
                  <code className="font-medical-id max-w-[200px] truncate rounded bg-muted px-1.5 py-0.5 text-xs" title={studyUid}>
                    {studyUid || "—"}
                  </code>
                  {studyUid && (
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={copyUid}>
                      {uidCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    </Button>
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        )}
      </Card>

      {/* Send Dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={(open) => { if (!open) closeSendDialog(); else setSendDialogOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Study to PACS</DialogTitle>
          </DialogHeader>
          <div className="rounded-md bg-muted p-3 space-y-1">
            <p className="text-sm font-medium">{stag("StudyDescription") || "Study"}</p>
            <p className="text-xs text-muted-foreground">
              {formatDicomName(ptag("PatientName"))} · {formatDicomDate(stag("StudyDate"))} · {series.length} series, {totalInstances} images
            </p>
          </div>

          {sendStatus === "idle" && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Destination</label>
                <Select value={selectedNode} onValueChange={setSelectedNode}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination PACS..." />
                  </SelectTrigger>
                  <SelectContent>
                    {pacsNodes.map((n) => (
                      <SelectItem key={n.id} value={String(n.id)}>
                        {n.name} ({n.ae_title})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {pacsNodes.length === 0 && (
                  <p className="text-xs text-muted-foreground">No PACS nodes configured.</p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeSendDialog}>Cancel</Button>
                <Button onClick={handleSend} disabled={!selectedNode}>
                  <Send className="mr-2 h-4 w-4" /> Send
                </Button>
              </DialogFooter>
            </>
          )}

          {sendStatus === "sending" && (
            <div className="py-6 text-center space-y-3">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm font-medium">Sending...</p>
            </div>
          )}

          {sendStatus === "success" && (
            <div className="py-6 text-center space-y-3">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                <Check className="h-6 w-6 text-emerald-500" />
              </div>
              <p className="text-sm font-medium">Study sent successfully</p>
              <DialogFooter className="justify-center">
                <Button onClick={closeSendDialog}>Done</Button>
              </DialogFooter>
            </div>
          )}

          {sendStatus === "error" && (() => {
            const parts = (sendError || "").split("\n\nTechnical details: ");
            const userMessage = parts[0];
            const techDetails = parts[1] || null;
            return (
              <div className="py-4 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                    <Send className="h-5 w-5 text-destructive" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium">Transfer failed</p>
                    <p className="text-sm text-muted-foreground">{userMessage}</p>
                  </div>
                </div>
                {techDetails && (
                  <details className="rounded-md border bg-muted/50 p-3">
                    <summary className="text-xs font-medium cursor-pointer text-muted-foreground">Technical details</summary>
                    <pre className="mt-2 text-xs whitespace-pre-wrap break-all text-destructive">{techDetails}</pre>
                  </details>
                )}
                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={closeSendDialog}>Close</Button>
                  <Button onClick={() => { setSendStatus("idle"); setSendError(null); }}>Try Again</Button>
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Share Dialog — config step then result with QR */}
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
                <Button onClick={handleShareCreate} disabled={sharing} className="gap-2">
                  <Share2 className="h-4 w-4" />
                  {sharing ? "Creating..." : "Create Link"}
                </Button>
              </DialogFooter>
            </div>
          )}

          {shareStep === "result" && (
            <div className="space-y-4">
              {/* QR Code + download */}
              {shareLink && (
                <div className="flex flex-col items-center gap-3 py-2">
                  <div id="share-qr" className="rounded-lg border bg-white p-4">
                    <QRCodeSVG value={shareLink} size={180} />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      const svg = document.querySelector("#share-qr svg");
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

              {/* Link with copy — fixed width button */}
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
                    const studyDesc = stag("StudyDescription") || "your imaging study";
                    const studyDate = formatDicomDate(stag("StudyDate"));
                    const expiryText = shareExpiry > 0
                      ? `This link will expire in ${shareExpiry} days.`
                      : "This link does not expire.";
                    const pinText = sharePin
                      ? `\n\nYou will need the following PIN to access your records: ${sharePin}`
                      : "";

                    const subject = encodeURIComponent(`Your Imaging Records — ${studyDesc}`);
                    const body = encodeURIComponent(
`Dear ${patientName},

Your imaging records from ${studyDate} (${studyDesc}) are now available for viewing and download through our secure patient portal.

Click the link below to access your records:
${shareLink}
${pinText}

${expiryText}

What you can do:
• View your images online in our DICOM viewer
• Download your images as a ZIP file for your records
• Share this link with another physician if needed

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

      {/* Download Dialog — confirmation before download */}
      <Dialog open={downloadDialogOpen} onOpenChange={setDownloadDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Download Study</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="font-medium">{stag("StudyDescription") || "Study"}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {series.length} series · {totalInstances} images · DICOM ZIP archive
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              The study will be downloaded as a ZIP file containing all DICOM images. This may take a moment for large studies.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDownloadDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleDownloadConfirm} className="gap-2">
              <Download className="h-4 w-4" />
              Download ZIP
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
