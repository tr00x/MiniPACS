import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Eye } from "lucide-react";
import api from "@/lib/api";

interface PatientData {
  MainDicomTags: {
    PatientID?: string;
    PatientName?: string;
    PatientBirthDate?: string;
    PatientSex?: string;
  };
}

interface Study {
  ID: string;
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
  };
}

interface Share {
  id: number;
  orthanc_patient_id: string;
  token: string;
  is_active: boolean;
  view_count: number;
  created_at: string;
  expires_at: string | null;
}

export function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<PatientData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      api.get(`/patients/${id}`, { signal: ctrl.signal }),
      api.get("/shares", { params: { patient_id: id }, signal: ctrl.signal }),
    ])
      .then(([patientRes, sharesRes]) => {
        setPatient(patientRes.data.patient);
        setStudies(patientRes.data.studies);
        setShares(sharesRes.data);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Failed to load patient");
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [id]);

  if (!id) {
    return <p className="text-muted-foreground">Invalid patient ID</p>;
  }

  const ptag = (key: keyof PatientData["MainDicomTags"]) =>
    patient?.MainDicomTags?.[key] || "";

  const stag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (error) {
    return <p className="text-destructive" role="alert">Error: {error}</p>;
  }

  if (!patient) {
    return <p className="text-muted-foreground">Patient not found</p>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">
        {ptag("PatientName") || ptag("PatientID") || "Unknown Patient"}
      </h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Patient Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Patient ID</dt>
              <dd className="font-mono">{ptag("PatientID")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Birth Date</dt>
              <dd>{ptag("PatientBirthDate")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sex</dt>
              <dd>{ptag("PatientSex")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total Studies</dt>
              <dd>{studies.length}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Studies</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Accession</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studies.map((s) => (
                <TableRow key={s.ID}>
                  <TableCell>{stag(s, "StudyDate")}</TableCell>
                  <TableCell>{stag(s, "StudyDescription")}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {stag(s, "ModalitiesInStudy") || "\u2014"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {stag(s, "AccessionNumber")}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" asChild>
                      <Link to={`/studies/${s.ID}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {studies.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-muted-foreground"
                  >
                    No studies found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Patient Shares</CardTitle>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shares for this patient
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Views</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shares.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">
                      {(s.token ?? "").slice(0, 16)}...
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={s.is_active ? "default" : "secondary"}
                      >
                        {s.is_active ? "Active" : "Revoked"}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.view_count}</TableCell>
                    <TableCell>{s.created_at}</TableCell>
                    <TableCell>{s.expires_at || "No expiry"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
