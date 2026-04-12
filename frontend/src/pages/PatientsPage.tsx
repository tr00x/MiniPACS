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
import { Search, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import api from "@/lib/api";
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
  const [patients, setPatients] = useState<Patient[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      api
        .get("/patients", {
          params: {
            ...(search ? { search } : {}),
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
          },
          signal: ctrl.signal,
        })
        .then(({ data }) => {
          setPatients(data.items);
          setTotal(data.total);
        })
        .catch((err) => {
          if (err.name !== "CanceledError" && err.name !== "AbortError") {
            setError(err?.response?.data?.detail ?? err.message ?? "Failed to load patients");
          }
        })
        .finally(() => setLoading(false));
    }, 300);

    return () => {
      ctrl.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, page]);

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
                  <TableHead className="w-[220px] cursor-pointer group" onClick={() => toggleSort("name")}>
                    <span className="flex items-center gap-1">Patient <SortIcon col="name" /></span>
                  </TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead className="cursor-pointer group" onClick={() => toggleSort("dob")}>
                    <span className="flex items-center gap-1">Date of Birth <SortIcon col="dob" /></span>
                  </TableHead>
                  <TableHead>Sex</TableHead>
                  <TableHead>Last Study</TableHead>
                  <TableHead className="text-right cursor-pointer group" onClick={() => toggleSort("studies")}>
                    <span className="flex items-center gap-1 justify-end">Studies <SortIcon col="studies" /></span>
                  </TableHead>
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
                  return (
                    <TableRow key={p.ID} className="cursor-pointer hover:bg-accent/50" onClick={() => navigate(`/patients/${p.ID}`)}>
                      <TableCell>
                        <span className="font-medium">{formatDicomName(rawName)}</span>
                      </TableCell>
                      <TableCell>
                        <code className="font-medical-id rounded bg-muted px-1.5 py-0.5 text-xs">{tag(p, "PatientID")}</code>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{formatDicomDate(dob)}</span>
                        {dob && <span className="ml-1.5 text-xs text-muted-foreground">({calculateAge(dob)})</span>}
                      </TableCell>
                      <TableCell className="text-sm">
                        {sex === "M" ? "Male" : sex === "F" ? "Female" : sex || "\u2014"}
                      </TableCell>
                      <TableCell>
                        {lastStudy ? (
                          <div className="flex items-center gap-2">
                            {modality && <ModalityBadgeList modalities={modality.replace(/\\/g, "/").split("/")} />}
                            <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                              {lastStudy.StudyDescription || "\u2014"}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60 shrink-0">
                              {formatDicomDate(lastStudy.StudyDate || "")}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">\u2014</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">{studyCount}</TableCell>
                    </TableRow>
                  );
                })}
                {patients.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
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
