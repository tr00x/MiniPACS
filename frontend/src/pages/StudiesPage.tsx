import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight } from "lucide-react";
import api from "@/lib/api";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";
import { ModalityBadge } from "@/components/ui/modality-badge";
import { TableSkeleton } from "@/components/TableSkeleton";
import { PageError } from "@/components/page-error";

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

type DatePreset = "today" | "7d" | "30d" | "all" | "custom";

const getDateRange = (preset: DatePreset): { from: string; to: string } | null => {
  if (preset === "custom") return null; // handled by custom inputs
  if (preset === "all") return { from: "", to: "" };
  const now = new Date();
  const to = now.toISOString().slice(0, 10).replace(/-/g, "");
  const daysBack = preset === "today" ? 0 : preset === "7d" ? 7 : 30;
  const from = new Date(now.getTime() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  return { from, to };
};

export function StudiesPage() {
  const navigate = useNavigate();
  const [studies, setStudies] = useState<Study[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [modFilter, setModFilter] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [page, setPage] = useState(1);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  };

  const handleModFilter = (mod: string) => {
    setModFilter(mod);
    setPage(1);
  };

  const handleDatePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    setPage(1);
  };

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const range = getDateRange(datePreset);
    const from = range ? range.from : customFrom.replace(/-/g, "");
    const to = range ? range.to : customTo.replace(/-/g, "");
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    if (debouncedSearch) params.search = debouncedSearch;
    if (modFilter) params.modality = modFilter;
    if (from) params.date_from = from;
    if (to) params.date_to = to;

    api
      .get("/studies", { params, signal: ctrl.signal })
      .then(({ data }) => {
        setStudies(data.items);
        setTotal(data.total);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(
            err?.response?.data?.detail ?? err.message ?? "Failed to load studies"
          );
        }
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [debouncedSearch, modFilter, datePreset, customFrom, customTo, page]);

  const tag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  const ptag = (s: Study, key: keyof NonNullable<Study["PatientMainDicomTags"]>) =>
    s.PatientMainDicomTags?.[key] || "";

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Worklist</h2>
        <PageError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const datePresets: { key: DatePreset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
    { key: "all", label: "All" },
    { key: "custom", label: "Custom" },
  ];

  const modalities = ["CT", "MR", "US", "XR", "DX", "MG", "NM", "PT", "RF", "XA"];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Worklist</h2>
        <p className="text-sm text-muted-foreground">{total} studies</p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search patient, description..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />

        {/* Date presets */}
        <div className="flex gap-1">
          {datePresets.map((dp) => (
            <Button
              key={dp.key}
              variant={datePreset === dp.key ? "default" : "outline"}
              size="sm"
              onClick={() => handleDatePreset(dp.key)}
            >
              {dp.label}
            </Button>
          ))}
        </div>

        {/* Custom date range */}
        {datePreset === "custom" && (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={customFrom}
              onChange={(e) => { setCustomFrom(e.target.value); setPage(1); }}
              className="w-[140px] h-8 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={customTo}
              onChange={(e) => { setCustomTo(e.target.value); setPage(1); }}
              className="w-[140px] h-8 text-xs"
            />
          </div>
        )}

        {/* Modality chips */}
        <div className="flex gap-1">
          <Button
            variant={modFilter === "" ? "default" : "outline"}
            size="sm"
            onClick={() => handleModFilter("")}
          >
            All
          </Button>
          {modalities.map((m) => (
            <Button
              key={m}
              variant={modFilter === m ? "default" : "outline"}
              size="sm"
              onClick={() => handleModFilter(m)}
            >
              {m}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
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
                <TableHead>MRN</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead className="text-right">Series</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studies.map((s) => {
                const mod = tag(s, "ModalitiesInStudy");
                return (
                  <TableRow
                    key={s.ID}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => navigate(`/studies/${s.ID}`)}
                  >
                    <TableCell className="font-medium">
                      {formatDicomDate(tag(s, "StudyDate"))}
                    </TableCell>
                    <TableCell>
                      <span
                        className="font-medium text-primary hover:underline cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/patients/${s.ParentPatient}`);
                        }}
                      >
                        {formatDicomName(ptag(s, "PatientName"))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <code className="font-medical-id rounded bg-muted px-1.5 py-0.5 text-xs">
                        {ptag(s, "PatientID")}
                      </code>
                    </TableCell>
                    <TableCell>{tag(s, "StudyDescription") || "\u2014"}</TableCell>
                    <TableCell>
                      {mod ? <ModalityBadge modality={mod} /> : "\u2014"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="secondary" className="text-xs">
                        {s.Series?.length || 0}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {studies.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No studies match the current filters
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {/* Pagination */}
          {total > 0 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages} ({total} studies)
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
