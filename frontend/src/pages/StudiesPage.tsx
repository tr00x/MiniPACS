import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
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

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Studies</h2>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Patient</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Modality</TableHead>
              <TableHead>Accession</TableHead>
              <TableHead>Series</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {studies.map((s) => (
              <TableRow key={s.ID} className="cursor-pointer hover:bg-accent">
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {tag(s, "StudyDate")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {ptag(s, "PatientName")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {tag(s, "StudyDescription")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    <Badge variant="outline">
                      {tag(s, "ModalitiesInStudy") || "\u2014"}
                    </Badge>
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full font-mono text-xs">
                    {tag(s, "AccessionNumber")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/studies/${s.ID}`} className="block w-full">
                    {s.Series?.length || 0}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {studies.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No studies found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
