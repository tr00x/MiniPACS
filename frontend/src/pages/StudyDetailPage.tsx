import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
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
import { Download, Send, ExternalLink } from "lucide-react";
import { OhifViewer } from "@/components/viewer/OhifViewer";
import api from "@/lib/api";

interface StudyData {
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
    StudyInstanceUID?: string;
  };
  PatientMainDicomTags?: {
    PatientName?: string;
    PatientID?: string;
  };
}

interface Series {
  ID: string;
  MainDicomTags: {
    SeriesDescription?: string;
    Modality?: string;
    SeriesNumber?: string;
    NumberOfSeriesRelatedInstances?: string;
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

  if (!id) {
    return <p className="text-muted-foreground">Invalid study ID</p>;
  }

  const stag = (key: keyof StudyData["MainDicomTags"]) =>
    study?.MainDicomTags?.[key] || "";

  const ptag = (key: keyof NonNullable<StudyData["PatientMainDicomTags"]>) =>
    study?.PatientMainDicomTags?.[key] || "";

  const handleSend = async () => {
    if (!selectedNode) return;
    setSending(true);
    setSendError(null);
    try {
      await api.post("/transfers", {
        orthanc_study_id: id,
        pacs_node_id: Number(selectedNode),
      });
      setSendDialogOpen(false);
      setSelectedNode("");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setSendError(e?.response?.data?.detail ?? e?.message ?? "Failed to send study");
    } finally {
      setSending(false);
    }
  };

  const [downloading, setDownloading] = useState(false);

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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to download study");
    } finally {
      setDownloading(false);
    }
  };

  const studyUid = stag("StudyInstanceUID");

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (error) {
    return <p className="text-destructive" role="alert">Error: {error}</p>;
  }

  if (!study) {
    return <p className="text-muted-foreground">Study not found</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">
          {stag("StudyDescription") || stag("AccessionNumber") || "Study"}
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setSendDialogOpen(true)}>
            <Send className="mr-2 h-4 w-4" />
            Send to PACS
          </Button>
          <Button variant="outline" onClick={handleDownload} disabled={downloading}>
            <Download className="mr-2 h-4 w-4" />
            {downloading ? "Downloading..." : "Download ZIP"}
          </Button>
          {viewers.map((v) => (
            <Button
              key={v.id}
              variant="outline"
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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Study Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Patient</dt>
              <dd>{ptag("PatientName")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Patient ID</dt>
              <dd className="font-mono">{ptag("PatientID")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Study Date</dt>
              <dd>{stag("StudyDate")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Modality</dt>
              <dd>
                <Badge variant="outline">
                  {stag("ModalitiesInStudy") || "\u2014"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Accession</dt>
              <dd className="font-mono text-xs">{stag("AccessionNumber")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Study UID</dt>
              <dd className="font-mono text-xs truncate max-w-xs" title={studyUid}>
                {studyUid}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total Series</dt>
              <dd>{series.length}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {studyUid && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">OHIF Viewer</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <OhifViewer studyInstanceUID={studyUid} className="h-[600px] w-full border-0" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Series</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Instances</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.map((s) => (
                <TableRow key={s.ID}>
                  <TableCell>{s.MainDicomTags?.SeriesNumber || ""}</TableCell>
                  <TableCell>{s.MainDicomTags?.SeriesDescription || ""}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {s.MainDicomTags?.Modality || "\u2014"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {s.MainDicomTags?.NumberOfSeriesRelatedInstances || "0"}
                  </TableCell>
                </TableRow>
              ))}
              {series.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No series found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={sendDialogOpen} onOpenChange={(open) => { setSendDialogOpen(open); if (!open) setSendError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Study to PACS</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Select value={selectedNode} onValueChange={setSelectedNode}>
              <SelectTrigger>
                <SelectValue placeholder="Select PACS node..." />
              </SelectTrigger>
              <SelectContent>
                {pacsNodes.map((n) => (
                  <SelectItem key={n.id} value={String(n.id)}>
                    {n.name} ({n.ae_title})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {sendError && (
            <p className="text-sm text-destructive" role="alert">{sendError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={!selectedNode || sending}>
              {sending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
