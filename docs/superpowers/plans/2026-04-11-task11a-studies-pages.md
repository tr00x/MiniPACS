# Task 11a: Studies Pages Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace StudiesPage.tsx and StudyDetailPage.tsx stubs with full implementations. StudyDetail includes OHIF viewer embed, download, and send-to-PACS functionality.

**Architecture:** Two pages — a studies list table and a study detail view with series table, OHIF iframe, action buttons. Data from `GET /api/studies` (list) and `GET /api/studies/{id}` (detail returning `{study, series}`). Viewers from `GET /api/viewers`. PACS nodes from `GET /api/pacs-nodes`. Transfers via `POST /api/transfers`.

**Tech Stack:** React 19, TypeScript, shadcn/ui (Table, Card, Badge, Button, Dialog, Select), lucide-react, axios via `@/lib/api`

---

## Context for implementer

### Backend API responses

**`GET /api/studies`** — array of Orthanc study objects:
```json
[{
  "ID": "orthanc-uuid",
  "ParentPatient": "patient-uuid",
  "MainDicomTags": {
    "StudyDate": "20260401",
    "StudyDescription": "CT CHEST",
    "ModalitiesInStudy": "CT",
    "AccessionNumber": "ACC001",
    "StudyInstanceUID": "1.2.3.4..."
  },
  "PatientMainDicomTags": {
    "PatientName": "DOE^JOHN",
    "PatientID": "MRN123"
  },
  "Series": ["series-uuid-1"]
}]
```

**`GET /api/studies/{id}`** — returns `{ study: {...}, series: [...] }`:
- `study` — same shape as list item
- `series` — array with MainDicomTags: SeriesDescription, Modality, SeriesNumber, NumberOfSeriesRelatedInstances

**`GET /api/viewers`** — array of external viewer configs:
```json
[{ "id": 1, "name": "RadiAnt", "url_template": "radiant://...", "is_enabled": true }]
```

**`GET /api/pacs-nodes`** — array of PACS nodes for send dialog:
```json
[{ "id": 1, "name": "Main PACS", "ae_title": "MAINPACS", "host": "192.168.1.10", "port": 4242 }]
```

**`POST /api/transfers`** — send study: `{ "orthanc_study_id": "...", "pacs_node_id": 1 }`

**`GET /api/studies/{id}/download`** — streams ZIP file

### Existing patterns (from PatientsPage/PatientDetailPage/DashboardPage)

- Typed interfaces at top
- `useState` + `useEffect` with AbortController
- Error catch: `err.name !== "CanceledError" && err.name !== "AbortError"`
- Error message: `err?.response?.data?.detail ?? err.message ?? "fallback"`
- `role="alert"` on error elements
- shadcn/ui Card, Table, Badge, Button asChild with Link

### Files

- `frontend/src/pages/StudiesPage.tsx` — 3-line stub, replace entirely
- `frontend/src/pages/StudyDetailPage.tsx` — 3-line stub, replace entirely
- Routes registered: `/studies` → StudiesPage, `/studies/:id` → StudyDetailPage

### shadcn/ui components needed

Already installed: Table, Card, Badge, Button, Input. May need: Dialog, Select (check if installed, install if not).

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/pages/StudiesPage.tsx` | Replace stub | Studies list table with click → detail |
| `frontend/src/pages/StudyDetailPage.tsx` | Replace stub | Study metadata + series table + OHIF iframe + actions |

---

### Task 1: StudiesPage.tsx

**Files:**
- Replace: `frontend/src/pages/StudiesPage.tsx`

- [ ] **Step 1: Write StudiesPage.tsx**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import api from "@/lib/api";

interface Study {
  ID: string;
  ParentPatient: string;
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
  };
  PatientMainDicomTags?: {
    PatientName?: string;
    PatientID?: string;
  };
  Series?: string[];
}

export function StudiesPage() {
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get("/studies", { signal: ctrl.signal })
      .then(({ data }) => setStudies(data))
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load studies");
        }
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, []);

  const tag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  const ptag = (s: Study, key: keyof NonNullable<Study["PatientMainDicomTags"]>) =>
    s.PatientMainDicomTags?.[key] || "";

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Studies</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Studies</h2>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Patient</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Modality</TableHead>
              <TableHead>Accession</TableHead>
              <TableHead>Series</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {studies.map((s) => (
              <TableRow key={s.ID} className="cursor-pointer hover:bg-accent">
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {tag(s, "StudyDate")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {ptag(s, "PatientName")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {tag(s, "StudyDescription")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    <Badge variant="outline">
                      {tag(s, "ModalitiesInStudy") || "\u2014"}
                    </Badge>
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full font-mono text-xs">
                    {tag(s, "AccessionNumber")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {s.Series?.length || 0}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {studies.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No studies found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`

---

### Task 2: StudyDetailPage.tsx

**Files:**
- Replace: `frontend/src/pages/StudyDetailPage.tsx`

**Note:** This page needs Dialog and Select for "Send to PACS" feature. Check if installed, install if not:
```bash
cd frontend && npx shadcn@latest add dialog select --yes 2>/dev/null || true
```

- [ ] **Step 1: Write StudyDetailPage.tsx**

```tsx
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
  url_template: string;
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
    try {
      await api.post("/transfers", {
        orthanc_study_id: id,
        pacs_node_id: Number(selectedNode),
      });
      setSendDialogOpen(false);
      setSelectedNode("");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to send study");
    } finally {
      setSending(false);
    }
  };

  const handleDownload = () => {
    window.open(`/api/studies/${id}/download`, "_blank");
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
          <Button variant="outline" onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" />
            Download ZIP
          </Button>
          {viewers.map((v) => (
            <Button
              key={v.id}
              variant="outline"
              onClick={() => {
                const url = v.url_template
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
            <iframe
              src={`/ohif/viewer?StudyInstanceUIDs=${studyUid}`}
              className="h-[600px] w-full border-0"
              title="OHIF DICOM Viewer"
              allow="fullscreen"
            />
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

      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
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
```

- [ ] **Step 2: Install Dialog and Select if needed**

Run: `cd frontend && npx shadcn@latest add dialog select --yes`

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 4: Verify production build**

Run: `cd frontend && npx vite build`

---

### Task 3: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add frontend/src/pages/StudiesPage.tsx frontend/src/pages/StudyDetailPage.tsx
git commit -m "feat: add studies pages with OHIF viewer integration"
```

(Also commit any new shadcn/ui components if Dialog/Select were added)

---

## Verification Checklist

- [ ] TypeScript compiles with no errors
- [ ] Production build succeeds
- [ ] `/studies` route renders table
- [ ] `/studies/:id` route renders study detail with OHIF iframe
- [ ] Send to PACS dialog opens and has node selector
- [ ] Download ZIP button works
- [ ] External viewer buttons render for enabled viewers
- [ ] No `any` types in component code
