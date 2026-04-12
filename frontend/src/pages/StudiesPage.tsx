import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, FileImage, Layers } from "lucide-react";
import api from "@/lib/api";
import { formatDicomName, formatDicomDate, getModalityColor } from "@/lib/dicom";
import { TableSkeleton } from "@/components/TableSkeleton";

interface Study {
  ID: string;
  ParentPatient: string;
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
    InstitutionName?: string;
    ReferringPhysicianName?: string;
  };
  PatientMainDicomTags?: {
    PatientName?: string;
    PatientID?: string;
  };
  Series?: string[];
}

const PAGE_SIZE = 25;

export function StudiesPage() {
  const navigate = useNavigate();
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedModality, setSelectedModality] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value);
      setPage(1);
    }, 300);
  };

  const handleModalityChange = (value: string) => {
    setSelectedModality(value);
    setPage(1);
  };

  const handleDateFromChange = (value: string) => {
    setDateFrom(value);
    setPage(1);
  };

  const handleDateToChange = (value: string) => {
    setDateTo(value);
    setPage(1);
  };

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

  // Derive unique modalities
  const modalities = Array.from(
    new Set(studies.map((s) => tag(s, "ModalitiesInStudy")).filter(Boolean))
  ).sort();

  // Client-side filtering
  const filtered = studies.filter((s) => {
    if (debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      const name = formatDicomName(ptag(s, "PatientName")).toLowerCase();
      const desc = tag(s, "StudyDescription").toLowerCase();
      const pid = ptag(s, "PatientID").toLowerCase();
      const institution = tag(s, "InstitutionName").toLowerCase();
      if (!name.includes(q) && !desc.includes(q) && !pid.includes(q) && !institution.includes(q)) return false;
    }
    if (selectedModality !== "all") {
      if (tag(s, "ModalitiesInStudy") !== selectedModality) return false;
    }
    if (dateFrom) {
      const studyDate = tag(s, "StudyDate");
      // DICOM date is YYYYMMDD, input date is YYYY-MM-DD
      const studyDateNorm = studyDate.replace(/-/g, "");
      const fromNorm = dateFrom.replace(/-/g, "");
      if (studyDateNorm && studyDateNorm < fromNorm) return false;
    }
    if (dateTo) {
      const studyDate = tag(s, "StudyDate");
      const studyDateNorm = studyDate.replace(/-/g, "");
      const toNorm = dateTo.replace(/-/g, "");
      if (studyDateNorm && studyDateNorm > toNorm) return false;
    }
    return true;
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search by patient name, description..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <Select value={selectedModality} onValueChange={handleModalityChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Modalities" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modalities</SelectItem>
            {modalities.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => handleDateFromChange(e.target.value)}
          className="w-[160px]"
          title="Date from"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => handleDateToChange(e.target.value)}
          className="w-[160px]"
          title="Date to"
        />
      </div>

      {loading ? (
        <div className="rounded-lg border">
          <TableSkeleton columns={6} />
        </div>
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
              {paginated.map((s) => {
                const mod = tag(s, "ModalitiesInStudy");
                const modClass = getModalityColor(mod);
                return (
                  <TableRow key={s.ID} className="cursor-pointer hover:bg-accent/50" onClick={() => navigate(`/studies/${s.ID}`)}>
                    <TableCell className="font-medium">
                      {formatDicomDate(tag(s, "StudyDate"))}
                    </TableCell>
                    <TableCell>
                      <div>
                        <span
                          className="font-medium text-primary hover:underline cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); navigate(`/patients/${s.ParentPatient}`); }}
                        >
                          {formatDicomName(ptag(s, "PatientName"))}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">{ptag(s, "PatientID")}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {tag(s, "StudyDescription") || "—"}
                    </TableCell>
                    <TableCell>
                      {mod ? (
                        <Badge variant="outline" className={`font-mono text-xs ${modClass}`}>
                          {mod}
                        </Badge>
                      ) : "—"}
                    </TableCell>
                    <TableCell>
                      {tag(s, "AccessionNumber") ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {tag(s, "AccessionNumber")}
                        </code>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="secondary" className="text-xs">
                          {s.Series?.length || 0}
                        </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    {studies.length === 0 ? "No imaging studies in the system" : "No studies match the current filters"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {/* Pagination */}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages} ({filtered.length} studies)
              </p>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
