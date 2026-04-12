import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
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

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Patient ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Birth Date</TableHead>
              <TableHead>Sex</TableHead>
              <TableHead>Studies</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {patients.map((p) => (
              <TableRow key={p.ID} className="cursor-pointer hover:bg-accent">
                <TableCell>
                  <Link to={`/patients/${p.ID}`} className="block w-full font-mono text-sm">
                    {tag(p, "PatientID")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/patients/${p.ID}`} className="block w-full">
                    {tag(p, "PatientName")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/patients/${p.ID}`} className="block w-full">
                    {tag(p, "PatientBirthDate")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/patients/${p.ID}`} className="block w-full">
                    {tag(p, "PatientSex")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/patients/${p.ID}`} className="block w-full">
                    {p.Studies?.length || 0}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {patients.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No patients found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
