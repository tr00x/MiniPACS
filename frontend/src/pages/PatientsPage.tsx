import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
import api from "@/lib/api";
import { TableSkeleton } from "@/components/TableSkeleton";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";

interface Patient {
  ID: string;
  MainDicomTags: {
    PatientID?: string;
    PatientName?: string;
    PatientBirthDate?: string;
    PatientSex?: string;
  };
  Studies?: string[];
}

export function PatientsPage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    const ctrl = new AbortController();

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      api
        .get("/patients", {
          params: search ? { search } : {},
          signal: ctrl.signal,
        })
        .then(({ data }) => setPatients(data))
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
  }, [search]);

  const tag = (p: Patient, key: keyof Patient["MainDicomTags"]) =>
    p.MainDicomTags?.[key] || "";

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
        <p className="text-destructive" role="alert">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
          <p className="text-sm text-muted-foreground">
            {patients.length} patients
          </p>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="rounded-lg border"><TableSkeleton columns={5} /></div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-[280px]">Patient</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Date of Birth</TableHead>
                <TableHead>Sex</TableHead>
                <TableHead className="text-right">Studies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patients.map((p) => {
                const rawName = tag(p, "PatientName");
                const studyCount = p.Studies?.length || 0;
                return (
                  <TableRow key={p.ID} className="cursor-pointer hover:bg-accent/50" onClick={() => navigate(`/patients/${p.ID}`)}>
                    <TableCell className="font-medium">
                      {formatDicomName(rawName)}
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {tag(p, "PatientID")}
                      </code>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDicomDate(tag(p, "PatientBirthDate"))}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {tag(p, "PatientSex") === "M" ? "Male" : tag(p, "PatientSex") === "F" ? "Female" : tag(p, "PatientSex") || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={studyCount > 1 ? "default" : "secondary"} className="text-xs">
                        {studyCount}
                      </Badge>
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
      )}
    </div>
  );
}
