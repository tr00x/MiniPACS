import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, List, LayoutGrid, Upload } from "lucide-react";
import { ImportDialog } from "@/components/ImportDialog";
import { useStudies, usePrefetchStudyFull, usePrefetchPatientFull } from "@/hooks/queries";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";
import { ModalityBadgeList } from "@/components/ui/modality-badge";
import { AuthedThumb } from "@/components/AuthedThumb";
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
  const [showHelp, setShowHelp] = useState(false);
  const [focusedRow, setFocusedRow] = useState<number>(-1);
  // Persist view preference so radiologists don't have to re-pick grid on every
  // reload. localStorage because it's per-workstation convenience, not session.
  const [viewMode, setViewMode] = useState<"list" | "grid">(() => {
    if (typeof window === "undefined") return "list";
    return (localStorage.getItem("studies.viewMode") as "list" | "grid") || "list";
  });
  const [importOpen, setImportOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [windowDragActive, setWindowDragActive] = useState(false);

  // Window-level drag overlay. If the radiologist drops files anywhere on
  // the worklist page (not just the modal), pop the import dialog with
  // those files already queued. The counter logic (dragDepth) is the
  // standard way to survive dragenter/dragleave firing on child nodes
  // as the pointer crosses element boundaries.
  useEffect(() => {
    let depth = 0;
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types || []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      if (depth === 1) setWindowDragActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setWindowDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setWindowDragActive(false);
      const files: File[] = [];
      if (e.dataTransfer) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          files.push(e.dataTransfer.files[i]);
        }
      }
      if (files.length) {
        setDroppedFiles(files);
        setImportOpen(true);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
      setFocusedRow(-1);
    }, 300);
  };

  const handleModFilter = (mod: string) => {
    setModFilter(mod);
    setPage(1);
    setFocusedRow(-1);
  };

  const handleDatePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    setPage(1);
    setFocusedRow(-1);
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

  // Keep the focused row visible — j/k can drive focus off-screen on long lists.
  useEffect(() => {
    if (focusedRow < 0) return;
    const el = document.querySelector(`[data-study-row-index="${focusedRow}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedRow]);

  const changeView = (mode: "list" | "grid") => {
    setViewMode(mode);
    try { localStorage.setItem("studies.viewMode", mode); } catch { /* private mode */ }
    setFocusedRow(-1);
  };

  useKeyboardNav([
    { key: "/", alwaysActive: true, handler: () => searchInputRef.current?.focus() },
    {
      key: "?",
      alwaysActive: true,
      handler: () => setShowHelp((v) => !v),
    },
    {
      key: "Escape",
      alwaysActive: true,
      handler: () => {
        if (showHelp) { setShowHelp(false); return; }
        // Clear search + filters + blur, so Esc always makes progress.
        if (searchQuery || modFilter || datePreset !== "all") {
          setSearchQuery("");
          setModFilter("");
          setDatePreset("all");
          setPage(1);
        }
        (document.activeElement as HTMLElement | null)?.blur?.();
      },
    },
    {
      key: "j",
      handler: () => setFocusedRow((i) => {
        const max = studies.length - 1;
        if (max < 0) return -1;
        return i < 0 ? 0 : Math.min(i + 1, max);
      }),
    },
    {
      key: "k",
      handler: () => setFocusedRow((i) => {
        if (studies.length === 0) return -1;
        return i <= 0 ? 0 : i - 1;
      }),
    },
    {
      key: "h",
      handler: () => { setPage((p) => Math.max(1, p - 1)); setFocusedRow(-1); },
    },
    {
      key: "l",
      handler: () => { setPage((p) => Math.min(totalPages, p + 1)); setFocusedRow(-1); },
    },
    {
      key: "g",
      handler: () => { setPage(1); setFocusedRow(0); },
    },
    {
      key: "G",
      handler: () => { setPage(totalPages); setFocusedRow(-1); },
    },
    {
      key: "Enter",
      handler: () => {
        const target = studies[focusedRow];
        if (target) navigate(`/studies/${target.ID}`);
      },
    },
  ]);

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
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="w-[min(560px,92vw)] rounded-lg border bg-background p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-lg font-semibold">Keyboard shortcuts</h3>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">/</kbd>
              <span>Focus search</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">Esc</kbd>
              <span>Clear search and filters, blur input</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">j / k</kbd>
              <span>Move focus down / up</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">h / l</kbd>
              <span>Previous / next page</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">g / G</kbd>
              <span>First / last page</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">Enter</kbd>
              <span>Open focused study</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">?</kbd>
              <span>Toggle this help</span>
            </div>
            <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              Search accepts modality codes (<code>CT</code>, <code>MR</code>, <code>US</code>…)
              and dates (<code>2024</code>, <code>2024-01</code>, <code>2024-01-15</code>,
              <code>2022-2024</code>) inline — e.g. <code>CT 2024 ivanov</code>.
            </div>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Worklist</h2>
          <p className="text-sm text-muted-foreground">{total} studies</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setDroppedFiles([]); setImportOpen(true); }}
            title="Import DICOM files, ZIP/TAR/7Z archives or ISO images"
          >
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => changeView("list")}
              title="List view"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "grid" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => changeView("grid")}
              title="Grid view with thumbnails"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Window-level drag overlay — any drop on the worklist page opens the
          import dialog with the files already queued. */}
      {windowDragActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm pointer-events-none">
          <div className="border-4 border-dashed border-primary rounded-xl p-12 bg-background/90 shadow-2xl">
            <Upload className="h-16 w-16 mx-auto text-primary mb-4" />
            <div className="text-2xl font-semibold text-center">Drop files to import</div>
            <div className="text-sm text-muted-foreground text-center mt-2">
              DICOM · ZIP · TAR · 7Z · ISO · folders
            </div>
          </div>
        </div>
      )}

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        initialFiles={droppedFiles}
      />

      {/* Filter bar */}
      <div className="space-y-3">
        <Input
          ref={searchInputRef}
          placeholder="Search patient name, description, MRN... (press /)"
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
                onChange={(e) => { setCustomFrom(e.target.value); setPage(1); setFocusedRow(-1); }}
                className="w-[150px] h-8"
              />
              <span className="text-sm text-muted-foreground">—</span>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => { setCustomTo(e.target.value); setPage(1); setFocusedRow(-1); }}
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
      ) : viewMode === "grid" ? (
        <div className={`transition-opacity ${fetching ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {studies.map((s, i) => {
              const mod = tag(s, "ModalitiesInStudy");
              const isFocused = focusedRow === i;
              return (
                <button
                  key={s.ID}
                  type="button"
                  data-study-row-index={i}
                  className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-all hover:border-primary/50 hover:shadow-md ${isFocused ? "border-primary ring-2 ring-primary/50" : ""}`}
                  onClick={() => navigate(`/studies/${s.ID}`)}
                  onMouseEnter={() => prefetchStudy(s.ID)}
                >
                  <div className="relative aspect-square w-full overflow-hidden bg-black">
                    <AuthedThumb studyId={s.ID} />
                    {mod && (
                      <div className="absolute left-2 top-2">
                        <ModalityBadgeList modalities={mod.replace(/\\/g, "/").split("/")} />
                      </div>
                    )}
                  </div>
                  <div className="p-2 space-y-0.5">
                    <p className="truncate text-sm font-medium">
                      {formatDicomName(ptag(s, "PatientName"))}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {tag(s, "StudyDescription") || "Untitled Study"}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatDicomDate(tag(s, "StudyDate"))}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          {studies.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No studies match the current filters
            </p>
          )}
          {total > 0 && (
            <div className="mt-4 flex items-center justify-between rounded-lg border px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages} ({total} studies)
              </p>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => { setPage((p) => Math.max(1, p - 1)); setFocusedRow(-1); }}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setFocusedRow(-1); }}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
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
              {studies.map((s, i) => {
                const mod = tag(s, "ModalitiesInStudy");
                const institution = tag(s, "InstitutionName");
                const referrer = tag(s, "ReferringPhysicianName");
                const accession = tag(s, "AccessionNumber");
                const isFocused = focusedRow === i;
                return (
                  <TableRow
                    key={s.ID}
                    data-study-row-index={i}
                    className={`cursor-pointer hover:bg-accent/50 ${isFocused ? "bg-accent" : ""}`}
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
                  onClick={() => { setPage((p) => Math.max(1, p - 1)); setFocusedRow(-1); }}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setFocusedRow(-1); }}
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
