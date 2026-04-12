import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Download, Send, ExternalLink, ArrowLeft, Layers, Info, Copy, Check, Share2 } from "lucide-react";
import { OhifViewer } from "@/components/viewer/OhifViewer";
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

  if (!id) return <p className="text-muted-foreground">Invalid study ID</p>;

  const stag = (key: keyof StudyData["MainDicomTags"]) => study?.MainDicomTags?.[key] || "";
  const ptag = (key: keyof NonNullable<StudyData["PatientMainDicomTags"]>) => study?.PatientMainDicomTags?.[key] || "";

  const [sendStatus, setSendStatus] = useState<"idle" | "sending" | "success" | "error">("idle");

  const handleSend = async () => {
    if (!selectedNode) return;
    setSending(true);
    setSendError(null);
    setSendStatus("sending");
    try {
      const { data } = await api.post("/transfers", { study_id: id, pacs_node_id: Number(selectedNode) });
      if (data.status === "failed") {
        setSendError(data.error_message || "Transfer failed — the destination PACS may be unreachable.");
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

  const handleDownload = async () => {
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
      setError(getErrorMessage(err, "Failed to download study"));
    } finally {
      setDownloading(false);
    }
  };

  const handleShare = async () => {
    if (!study?.ParentPatient) return;
    setSharing(true);
    try {
      const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const res = await api.post("/shares", {
        orthanc_patient_id: study.ParentPatient,
        expires_at: thirtyDaysFromNow,
      });
      const token = res.data?.token ?? res.data?.share_token ?? res.data?.id ?? "";
      const portalLink = token
        ? `${window.location.origin}/patient-portal/${token}`
        : "";
      if (portalLink) {
        await navigator.clipboard.writeText(portalLink);
        toast.success("Portal link copied to clipboard", {
          description: portalLink,
        });
      } else {
        toast.success("Share created successfully");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create share"));
    } finally {
      setSharing(false);
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
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">
                {stag("StudyDescription") || "Untitled Study"}
              </h2>
              {modality && (
                <Badge variant="outline" className="font-mono text-xs">
                  {modality}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {formatDicomName(ptag("PatientName"))} · MRN: {ptag("PatientID")} · {formatDicomDate(stag("StudyDate"))}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setSendDialogOpen(true)}>
            <Send className="mr-2 h-4 w-4" />
            Send to PACS
          </Button>
          {study?.ParentPatient && (
            <Button variant="outline" size="sm" onClick={handleShare} disabled={sharing}>
              <Share2 className="mr-2 h-4 w-4" />
              {sharing ? "Sharing..." : "Share with Patient"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={downloading}>
            <Download className="mr-2 h-4 w-4" />
            {downloading ? "Downloading..." : "Download"}
          </Button>
          {viewers.map((v) => (
            <Button
              key={v.id}
              variant="outline"
              size="sm"
              onClick={() => {
                const url = (v.url_scheme ?? "")
                  .replace("{StudyInstanceUID}", studyUid)
                  .replace("{study_id}", id);
                window.open(url, "_blank");
              }}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {v.name}
            </Button>
          ))}
        </div>
      </div>

      {/* Study Info */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Study Information</CardTitle>
          </div>
        </CardHeader>
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
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{ptag("PatientID") || "—"}</code>
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
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Modality</dt>
              <dd className="mt-1">
                {modality ? (
                  <Badge variant="outline" className="font-mono">{modality}</Badge>
                ) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Accession #</dt>
              <dd className="mt-1">
                {stag("AccessionNumber") ? (
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{stag("AccessionNumber")}</code>
                ) : "—"}
              </dd>
            </div>
            {stag("ReferringPhysicianName") && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Referring Physician</dt>
                <dd className="mt-1">{formatDicomName(stag("ReferringPhysicianName"))}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Study UID</dt>
              <dd className="mt-1 flex items-center gap-1">
                <code className="max-w-[200px] truncate rounded bg-muted px-1.5 py-0.5 text-xs" title={studyUid}>
                  {studyUid || "—"}
                </code>
                {studyUid && (
                  <Button variant="ghost" size="icon" className="h-5 w-5" onClick={copyUid}>
                    {uidCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                  </Button>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Series</dt>
              <dd className="mt-1 font-medium">{series.length}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Images</dt>
              <dd className="mt-1 font-medium">{totalInstances}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* OHIF Viewer */}
      {studyUid && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">DICOM Viewer</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <OhifViewer studyInstanceUID={studyUid} className="h-[600px] w-full rounded-b-lg border-0" />
          </CardContent>
        </Card>
      )}

      {/* Series Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Series ({series.length})</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-[60px]">#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Modality</TableHead>
                  <TableHead>Manufacturer</TableHead>
                  <TableHead className="text-right">Images</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.map((s) => (
                  <TableRow key={s.ID}>
                    <TableCell className="font-mono text-sm font-medium">
                      {s.MainDicomTags?.SeriesNumber || "—"}
                    </TableCell>
                    <TableCell>{s.MainDicomTags?.SeriesDescription || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {s.MainDicomTags?.Modality || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.MainDicomTags?.Manufacturer || "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {s.MainDicomTags?.NumberOfSeriesRelatedInstances || "0"}
                    </TableCell>
                  </TableRow>
                ))}
                {series.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                      No series in this study
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Send Dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={(open) => { if (!open) closeSendDialog(); else setSendDialogOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Study to PACS</DialogTitle>
          </DialogHeader>

          {/* Study info */}
          <div className="rounded-md bg-muted p-3 space-y-1">
            <p className="text-sm font-medium">{stag("StudyDescription") || "Study"}</p>
            <p className="text-xs text-muted-foreground">
              {formatDicomName(ptag("PatientName"))} · {formatDicomDate(stag("StudyDate"))} · {series.length} series, {series.reduce((sum, s) => sum + parseInt(s.MainDicomTags?.NumberOfSeriesRelatedInstances || "0", 10), 0)} images
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
                  <p className="text-xs text-muted-foreground">No PACS nodes configured. Add one in Settings → PACS Nodes.</p>
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
              <p className="text-sm font-medium">Sending to {pacsNodes.find(n => String(n.id) === selectedNode)?.name}...</p>
              <p className="text-xs text-muted-foreground">This may take a moment depending on the study size.</p>
            </div>
          )}

          {sendStatus === "success" && (
            <div className="py-6 text-center space-y-3">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                <Check className="h-6 w-6 text-emerald-500" />
              </div>
              <p className="text-sm font-medium">Study sent successfully</p>
              <p className="text-xs text-muted-foreground">
                Sent to {pacsNodes.find(n => String(n.id) === selectedNode)?.name}. Check the Transfers page for status.
              </p>
              <DialogFooter className="justify-center">
                <Button onClick={closeSendDialog}>Done</Button>
              </DialogFooter>
            </div>
          )}

          {sendStatus === "error" && (
            <div className="py-6 text-center space-y-3">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                <Send className="h-6 w-6 text-destructive" />
              </div>
              <p className="text-sm font-medium">Transfer failed</p>
              <p className="text-sm text-destructive">{sendError}</p>
              <DialogFooter className="justify-center gap-2">
                <Button variant="outline" onClick={closeSendDialog}>Close</Button>
                <Button onClick={() => { setSendStatus("idle"); setSendError(null); }}>Try Again</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
