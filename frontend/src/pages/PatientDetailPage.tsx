import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Eye, FileImage, Share2, ArrowLeft, Copy, Check } from "lucide-react";
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
    StudyInstanceUID?: string;
  };
}

interface Share {
  id: number;
  orthanc_patient_id: string;
  token: string;
  is_active: boolean;
  view_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  created_at: string;
  expires_at: string | null;
}

function formatDicomName(raw: string): string {
  if (!raw) return "Unknown Patient";
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
  return new Date(parseInt(y), m, d).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatTimestamp(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function calculateAge(birthDate: string): string {
  if (!birthDate || birthDate.length !== 8) return "";
  const y = parseInt(birthDate.slice(0, 4));
  const m = parseInt(birthDate.slice(4, 6)) - 1;
  const d = parseInt(birthDate.slice(6, 8));
  const birth = new Date(y, m, d);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) {
    age--;
  }
  return `${age} yrs`;
}

function getShareStatus(s: Share): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (!s.is_active) return { label: "Revoked", variant: "secondary" };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { label: "Expired", variant: "destructive" };
  return { label: "Active", variant: "default" };
}

export function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<PatientData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<number | null>(null);

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

  const copyToken = (shareId: number, token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedToken(shareId);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (error) {
    return <p className="text-destructive" role="alert">Error: {error}</p>;
  }

  if (!patient) {
    return <p className="text-muted-foreground">Patient not found</p>;
  }

  const rawBirth = ptag("PatientBirthDate");
  const sex = ptag("PatientSex");

  return (
    <div className="space-y-6">
      {/* Header with back button */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/patients">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {formatDicomName(ptag("PatientName"))}
          </h2>
          <p className="text-sm text-muted-foreground">
            MRN: {ptag("PatientID")}
            {rawBirth ? ` · ${formatDicomDate(rawBirth)} (${calculateAge(rawBirth)})` : ""}
            {sex ? ` · ${sex === "M" ? "Male" : sex === "F" ? "Female" : sex}` : ""}
          </p>
        </div>
      </div>

      {/* Demographics card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Demographics</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Medical Record #</dt>
              <dd className="mt-1 font-mono">{ptag("PatientID") || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Date of Birth</dt>
              <dd className="mt-1">{formatDicomDate(rawBirth)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Age</dt>
              <dd className="mt-1">{calculateAge(rawBirth) || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sex</dt>
              <dd className="mt-1">
                <Badge variant="outline">
                  {sex === "M" ? "Male" : sex === "F" ? "Female" : sex || "—"}
                </Badge>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Studies */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <FileImage className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Studies ({studies.length})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Modality</TableHead>
                  <TableHead>Accession #</TableHead>
                  <TableHead className="w-[80px]">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {studies.map((s) => (
                  <TableRow key={s.ID} className="hover:bg-accent/50">
                    <TableCell className="font-medium">
                      {formatDicomDate(stag(s, "StudyDate"))}
                    </TableCell>
                    <TableCell>{stag(s, "StudyDescription") || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {stag(s, "ModalitiesInStudy") || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {stag(s, "AccessionNumber") ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {stag(s, "AccessionNumber")}
                        </code>
                      ) : "—"}
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
                    <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                      No imaging studies on file
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Shares */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Patient Portal Links ({shares.length})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No portal links shared with this patient
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>Token</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Views</TableHead>
                    <TableHead>First Viewed</TableHead>
                    <TableHead>Last Viewed</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shares.map((s) => {
                    const status = getShareStatus(s);
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {(s.token ?? "").slice(0, 12)}…
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => copyToken(s.id, s.token)}
                            >
                              {copiedToken === s.id ? (
                                <Check className="h-3 w-3 text-emerald-500" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">{s.view_count}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(s.first_viewed_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(s.last_viewed_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(s.created_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {s.expires_at ? formatTimestamp(s.expires_at) : "No expiry"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
