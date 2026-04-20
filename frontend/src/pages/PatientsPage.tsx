import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { TableSkeleton } from "@/components/TableSkeleton";
import { PageError } from "@/components/page-error";
import { ModalityBadgeList } from "@/components/ui/modality-badge";
import { Search, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ExternalLink } from "lucide-react";
import { usePatients } from "@/hooks/queries";
import { formatDicomName, formatDicomDate, calculateAge } from "@/lib/dicom";

const PAGE_SIZE = 50;

interface Patient {
  ID: string;
  MainDicomTags: {
    PatientID?: string;
    PatientName?: string;
    PatientBirthDate?: string;
    PatientSex?: string;
  };
  Studies?: string[];
  LastStudy?: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
  };
}

type SortKey = "name" | "dob" | "studies";
type SortDir = "asc" | "desc";

export function PatientsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Debounce search into a separate state so the React Query key stays stable
  // while the user is typing.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const patientsQuery = usePatients({
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const patients: Patient[] = (patientsQuery.data?.items as Patient[]) ?? [];
  const total: number = patientsQuery.data?.total ?? 0;
  const loading = patientsQuery.isLoading;
  const error = patientsQuery.error
    ? ((patientsQuery.error as any)?.response?.data?.detail ?? (patientsQuery.error as any)?.message ?? "Failed to load patients")
    : null;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const tag = (p: Patient, key: keyof Patient["MainDicomTags"]) =>
    p.MainDicomTags?.[key] || "";

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronUp className="h-3 w-3 opacity-0 group-hover:opacity-30" />;
    return sortDir === "asc"
      ? <ChevronUp className="h-3 w-3" />
      : <ChevronDown className="h-3 w-3" />;
  };

  // Client-side sort of current page only
  const sorted = [...patients].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "name") {
      return dir * (formatDicomName(tag(a, "PatientName"))).localeCompare(formatDicomName(tag(b, "PatientName")));
    }
    if (sortKey === "dob") {
      return dir * (tag(a, "PatientBirthDate") || "").localeCompare(tag(b, "PatientBirthDate") || "");
    }
    if (sortKey === "studies") {
      return dir * ((a.Studies?.length || 0) - (b.Studies?.length || 0));
    }
    return 0;
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
        <PageError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
          <p className="text-sm text-muted-foreground">
            {total} patient{total !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name or ID..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="rounded-lg border"><TableSkeleton columns={6} /></div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="cursor-pointer group" onClick={() => toggleSort("name")}>
                    <span className="flex items-center gap-1">Patient <SortIcon col="name" /></span>
                  </TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Last Study</TableHead>
                  <TableHead className="text-center cursor-pointer group" onClick={() => toggleSort("studies")}>
                    <span className="flex items-center gap-1 justify-center">Studies <SortIcon col="studies" /></span>
                  </TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p) => {
                  const rawName = tag(p, "PatientName");
                  const studyCount = p.Studies?.length || 0;
                  const dob = tag(p, "PatientBirthDate");
                  const sex = tag(p, "PatientSex");
                  const lastStudy = p.LastStudy;
                  const modality = lastStudy?.ModalitiesInStudy || "";
                  const lastStudyId = p.Studies?.[p.Studies.length - 1];
                  return (
                    <TableRow key={p.ID} className="cursor-pointer hover:bg-accent/50" onClick={() => navigate(`/patients/${p.ID}`)}>
                      <TableCell>
                        <div>
                          <span className="font-medium">{formatDicomName(rawName)}</span>
                          <div className="mt-0.5">
                            <code className="font-medical-id text-[11px] text-muted-foreground">{tag(p, "PatientID")}</code>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          <div className="text-sm">
                            {formatDicomDate(dob)}
                            {dob && <span className="ml-1 text-xs text-muted-foreground">({calculateAge(dob)})</span>}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            {sex === "M" && <span className="text-blue-500">&#9794;</span>}
                            {sex === "F" && <span className="text-pink-500">&#9792;</span>}
                            {sex === "M" ? "Male" : sex === "F" ? "Female" : sex || ""}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {lastStudy ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              {modality && <ModalityBadgeList modalities={modality.replace(/\\/g, "/").split("/")} />}
                              <span className="text-sm font-medium truncate max-w-[220px]">
                                {lastStudy.StudyDescription || "Untitled"}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatDicomDate(lastStudy.StudyDate || "")}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">No studies</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-sm font-medium">
                          {studyCount}
                        </span>
                      </TableCell>
                      <TableCell>
                        {lastStudyId && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 text-xs"
                            onClick={(e) => { e.stopPropagation(); navigate(`/studies/${lastStudyId}`); }}
                            title="Open last study"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Last
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {patients.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      {search ? "No patients match your search" : "No patients in the system"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Showing {Math.min((page - 1) * PAGE_SIZE + 1, total)}\u2013{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                  <ChevronLeft className="h-4 w-4" /> Prev
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
