import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Download } from "lucide-react";
import api from "@/lib/api";

interface PatientData {
  MainDicomTags: {
    PatientName?: string;
    PatientID?: string;
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
  };
}

interface ShareInfo {
  orthanc_patient_id: string;
  expires_at: string | null;
}

export function PatientPortalPage() {
  const { token } = useParams<{ token: string }>();
  const [patient, setPatient] = useState<PatientData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    api
      .get(`/patient-portal/${token}`, { signal: ctrl.signal })
      .then(({ data }) => {
        setPatient(data.patient);
        setStudies(data.studies);
        setShare(data.share);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          setError(err?.response?.data?.detail ?? err.message ?? "Unable to load patient portal");
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [token]);

  if (!token) {
    return <p className="text-muted-foreground">Invalid portal link</p>;
  }

  const ptag = (key: keyof PatientData["MainDicomTags"]) =>
    patient?.MainDicomTags?.[key] || "";

  const stag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  const handleDownload = async (studyId: string) => {
    try {
      const res = await api.get(`/patient-portal/${token}/download/${studyId}`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `study-${studyId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? "Failed to download study");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading your records...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-destructive" role="alert">{error}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Please contact the clinic if you believe this is an error.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Patient not found</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-3xl font-bold tracking-tight">Patient Portal</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Your Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium">{ptag("PatientName")}</dd>
            </div>
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
          </dl>
          {share?.expires_at && (
            <p className="mt-4 text-xs text-muted-foreground">
              This link expires on {share.expires_at}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Your Studies</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
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
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(s.ID)}>
                      <Download className="mr-1 h-3 w-3" />
                      Download
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {studies.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No studies available
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
