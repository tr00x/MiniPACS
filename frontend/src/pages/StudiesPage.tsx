import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FileImage, Layers } from "lucide-react";
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

function formatDicomName(raw: string): string {
  if (!raw) return "—";
  const parts = raw.split("^");
  const last = parts[0] || "";
  const first = parts[1] || "";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (first && last) return `${cap(first)} ${cap(last)}`;
  return cap(last || first);
}

function formatDicomDate(raw: string): string {
  if (!raw || raw.length !== 8) return raw || "—";
  const y = raw.slice(0, 4);
  const m = parseInt(raw.slice(4, 6), 10) - 1;
  const d = parseInt(raw.slice(6, 8), 10);
  return new Date(parseInt(y), m, d).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

const modalityColors: Record<string, string> = {
  CT: "bg-blue-500/10 text-blue-700 border-blue-200",
  MR: "bg-violet-500/10 text-violet-700 border-violet-200",
  CR: "bg-amber-500/10 text-amber-700 border-amber-200",
  DX: "bg-amber-500/10 text-amber-700 border-amber-200",
  US: "bg-emerald-500/10 text-emerald-700 border-emerald-200",
  NM: "bg-rose-500/10 text-rose-700 border-rose-200",
  PT: "bg-pink-500/10 text-pink-700 border-pink-200",
  XA: "bg-cyan-500/10 text-cyan-700 border-cyan-200",
};

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

  const totalSeries = studies.reduce((sum, s) => sum + (s.Series?.length || 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Studies</h2>
        <p className="text-sm text-muted-foreground">
          {studies.length} studies, {totalSeries} series
        </p>
      </div>

      <div className="flex gap-4">
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-blue-500/10 p-2">
              <FileImage className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{studies.length}</p>
              <p className="text-xs text-muted-foreground">Total Studies</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-violet-500/10 p-2">
              <Layers className="h-5 w-5 text-violet-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalSeries}</p>
              <p className="text-xs text-muted-foreground">Total Series</p>
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
                <TableHead>Date</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Accession #</TableHead>
                <TableHead className="text-right">Series</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studies.map((s) => {
                const mod = tag(s, "ModalitiesInStudy");
                const modClass = modalityColors[mod] || "";
                return (
                  <TableRow key={s.ID} className="cursor-pointer hover:bg-accent/50">
                    <TableCell>
                      <Link to={`/studies/${s.ID}`} className="block w-full font-medium">
                        {formatDicomDate(tag(s, "StudyDate"))}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/studies/${s.ID}`} className="block w-full">
                        <div>
                          <span className="font-medium">{formatDicomName(ptag(s, "PatientName"))}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{ptag(s, "PatientID")}</span>
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/studies/${s.ID}`} className="block w-full">
                        {tag(s, "StudyDescription") || "—"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/studies/${s.ID}`} className="block w-full">
                        {mod ? (
                          <Badge variant="outline" className={`font-mono text-xs ${modClass}`}>
                            {mod}
                          </Badge>
                        ) : "—"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/studies/${s.ID}`} className="block w-full">
                        {tag(s, "AccessionNumber") ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {tag(s, "AccessionNumber")}
                          </code>
                        ) : "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to={`/studies/${s.ID}`} className="block w-full">
                        <Badge variant="secondary" className="text-xs">
                          {s.Series?.length || 0}
                        </Badge>
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
              {studies.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No imaging studies in the system
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
