import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search, Users, UserCircle } from "lucide-react";
import api from "@/lib/api";

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

function formatDicomName(raw: string): string {
  if (!raw) return "Unknown";
  // DICOM: LAST^FIRST^MIDDLE → First Last
  const parts = raw.split("^");
  const last = parts[0] || "";
  const first = parts[1] || "";
  const capitalize = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (first && last) return `${capitalize(first)} ${capitalize(last)}`;
  return capitalize(last || first);
}

function formatDicomDate(raw: string): string {
  if (!raw || raw.length !== 8) return raw || "—";
  const y = raw.slice(0, 4);
  const m = parseInt(raw.slice(4, 6), 10) - 1;
  const d = parseInt(raw.slice(6, 8), 10);
  const date = new Date(parseInt(y), m, d);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getInitials(name: string): string {
  const parts = name.split("^");
  const last = parts[0]?.[0] || "";
  const first = parts[1]?.[0] || "";
  return (first + last).toUpperCase() || "?";
}

function getAvatarColor(name: string): string {
  const colors = [
    "bg-blue-500", "bg-emerald-500", "bg-violet-500",
    "bg-amber-500", "bg-rose-500", "bg-cyan-500",
    "bg-pink-500", "bg-indigo-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function PatientsPage() {
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

  const totalStudies = patients.reduce((sum, p) => sum + (p.Studies?.length || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
          <p className="text-sm text-muted-foreground">
            {patients.length} patients, {totalStudies} studies
          </p>
        </div>
      </div>

      <div className="flex gap-4">
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-blue-500/10 p-2">
              <Users className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{patients.length}</p>
              <p className="text-xs text-muted-foreground">Total Patients</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 pt-6">
            <div className="rounded-lg bg-emerald-500/10 p-2">
              <UserCircle className="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalStudies}</p>
              <p className="text-xs text-muted-foreground">Total Studies</p>
            </div>
          </CardContent>
        </Card>
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
        <p className="text-muted-foreground">Loading...</p>
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
                  <TableRow key={p.ID} className="cursor-pointer hover:bg-accent/50">
                    <TableCell>
                      <Link to={`/patients/${p.ID}`} className="flex items-center gap-3">
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium text-white ${getAvatarColor(rawName)}`}>
                          {getInitials(rawName)}
                        </div>
                        <span className="font-medium">
                          {formatDicomName(rawName)}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/patients/${p.ID}`} className="block w-full">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {tag(p, "PatientID")}
                        </code>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/patients/${p.ID}`} className="block w-full text-sm">
                        {formatDicomDate(tag(p, "PatientBirthDate"))}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/patients/${p.ID}`} className="block w-full">
                        <Badge variant="outline" className="text-xs">
                          {tag(p, "PatientSex") === "M" ? "Male" : tag(p, "PatientSex") === "F" ? "Female" : tag(p, "PatientSex") || "—"}
                        </Badge>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to={`/patients/${p.ID}`} className="block w-full">
                        <Badge variant={studyCount > 1 ? "default" : "secondary"} className="text-xs">
                          {studyCount}
                        </Badge>
                      </Link>
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
