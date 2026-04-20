import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useStudies, usePrefetchStudyFull, usePrefetchPatientFull } from "@/hooks/queries";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";
import { ModalityBadgeList } from "@/components/ui/modality-badge";
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

const PAGE_SIZE = 50;

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
  const prefetchStudy = usePrefetchStudyFull();
  const prefetchPatient = usePrefetchPatientFull();
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

  const range = getDateRange(datePreset);
  const fromParam = range ? range.from : customFrom.replace(/-/g, "");
  const toParam = range ? range.to : customTo.replace(/-/g, "");
  const queryParams = {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(modFilter ? { modality: modFilter } : {}),
    ...(fromParam ? { date_from: fromParam } : {}),
    ...(toParam ? { date_to: toParam } : {}),
  };
  const studiesQuery = useStudies(queryParams);
  const studies: Study[] = (studiesQuery.data?.items as Study[]) ?? [];
  const total: number = studiesQuery.data?.total ?? 0;
  const loading = studiesQuery.isLoading;
  // isFetching is true on any refetch (pagination, filter change with placeholder)
  // while isLoading is true only when there's no data yet. Use fetching for a
  // subtle "loading…" hint above the table without flashing the full skeleton.
  const fetching = studiesQuery.isFetching && !studiesQuery.isLoading;
  const error = studiesQuery.error
    ? ((studiesQuery.error as any)?.response?.data?.detail ?? (studiesQuery.error as any)?.message ?? "Failed to load studies")
    : null;

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
      <div className="space-y-3">
        <Input
          placeholder="Search patient name, description, MRN..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-md"
        />

        <div className="flex flex-wrap items-center gap-4">
          {/* Date presets */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground mr-1">Date:</span>
            {datePresets.map((dp) => (
              <Button
                key={dp.key}
                variant={datePreset === dp.key ? "default" : "outline"}
                size="default"
                className="h-8 px-3 text-sm"
                onClick={() => handleDatePreset(dp.key)}
              >
                {dp.label}
              </Button>
            ))}
          </div>

          {/* Custom date range */}
          {datePreset === "custom" && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => { setCustomFrom(e.target.value); setPage(1); }}
                className="w-[150px] h-8"
              />
              <span className="text-sm text-muted-foreground">—</span>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => { setCustomTo(e.target.value); setPage(1); }}
                className="w-[150px] h-8"
              />
            </div>
          )}

          {/* Modality chips */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground mr-1">Modality:</span>
            <Button
              variant={modFilter === "" ? "default" : "outline"}
              size="default"
              className="h-8 px-3 text-sm"
              onClick={() => handleModFilter("")}
            >
              All
            </Button>
            {modalities.map((m) => (
              <Button
                key={m}
                variant={modFilter === m ? "default" : "outline"}
                size="default"
                className="h-8 px-3 text-sm"
                onClick={() => handleModFilter(m)}
              >
                {m}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="rounded-lg border">
          <TableSkeleton columns={6} />
        </div>
      ) : (
        <div className={`rounded-lg border transition-opacity ${fetching ? "opacity-60" : ""}`}>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-[100px]">Date</TableHead>
                <TableHead className="w-[200px]">Patient</TableHead>
                <TableHead>Study</TableHead>
                <TableHead className="w-[100px]">Modality</TableHead>
                <TableHead className="w-[80px] text-right">Series</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studies.map((s) => {
                const mod = tag(s, "ModalitiesInStudy");
                const institution = tag(s, "InstitutionName");
                const referrer = tag(s, "ReferringPhysicianName");
                const accession = tag(s, "AccessionNumber");
                return (
                  <TableRow
                    key={s.ID}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => navigate(`/studies/${s.ID}`)}
                    onMouseEnter={() => prefetchStudy(s.ID)}
                  >
                    <TableCell>
                      <span className="font-medium">{formatDicomDate(tag(s, "StudyDate"))}</span>
                    </TableCell>
                    <TableCell>
                      <div>
                        <span
                          className="font-medium text-primary hover:underline cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/patients/${s.ParentPatient}`);
                          }}
                          onMouseEnter={(e) => {
                            e.stopPropagation();
                            prefetchPatient(s.ParentPatient);
                          }}
                        >
                          {formatDicomName(ptag(s, "PatientName"))}
                        </span>
                        <div className="flex items-center gap-2 mt-0.5">
                          <code className="font-medical-id text-[11px] text-muted-foreground">
                            {ptag(s, "PatientID")}
                          </code>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="font-medium text-sm">
                          {tag(s, "StudyDescription") || "Untitled Study"}
                        </span>
                        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                          {institution && <span>{institution}</span>}
                          {referrer && <span>Ref: {formatDicomName(referrer)}</span>}
                          {accession && <span className="font-medical-id">Acc# {accession}</span>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {mod ? <ModalityBadgeList modalities={mod.replace(/\\/g, "/").split("/")} /> : "\u2014"}
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
                    colSpan={5}
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
