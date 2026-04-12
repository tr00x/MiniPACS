import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, Eye, EyeOff, Shield, Phone, Mail, Calendar, User, Lock } from "lucide-react";
import { ModalityBadge } from "@/components/ui/modality-badge";
import axios from "axios";
import { OhifViewer } from "@/components/viewer/OhifViewer";
import { formatDicomName, formatDicomDate, formatTimestamp } from "@/lib/dicom";

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
    StudyInstanceUID?: string;
    InstitutionName?: string;
  };
}

interface ShareInfo {
  orthanc_patient_id: string;
  expires_at: string | null;
  has_pin?: boolean;
}

interface ClinicSettings {
  clinic_name?: string;
  clinic_phone?: string;
  clinic_email?: string;
}

const portalApi = axios.create({ baseURL: "/api" });

export function PatientPortalPage() {
  const { token } = useParams<{ token: string }>();
  const [patient, setPatient] = useState<PatientData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clinicSettings, setClinicSettings] = useState<ClinicSettings>({});
  const [viewingStudy, setViewingStudy] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  // PIN gate state
  const [needsPin, setNeedsPin] = useState<boolean | null>(null); // null = checking
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinVerified, setPinVerified] = useState(false);
  const [pinSubmitting, setPinSubmitting] = useState(false);

  useEffect(() => {
    portalApi.get("/settings/public")
      .then(({ data }) => setClinicSettings(data))
      .catch(() => {});
  }, []);

  // Step 1: Check if PIN is needed
  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();

    portalApi
      .get(`/patient-portal/${token}/info`, { signal: ctrl.signal })
      .then(({ data }) => {
        if (data.has_pin) {
          setNeedsPin(true);
          setLoading(false);
        } else {
          setNeedsPin(false);
          setPinVerified(true); // No PIN needed, proceed directly
        }
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          const status = err?.response?.status;
          if (status === 410) {
            setError("This link has expired or been revoked. Please contact the clinic for a new link.");
          } else if (status === 404) {
            setError("This link is invalid. Please check the link or contact the clinic.");
          } else {
            setError(err?.response?.data?.detail ?? "Unable to load your records. Please try again later.");
          }
          setLoading(false);
        }
      });

    return () => ctrl.abort();
  }, [token]);

  // Step 2: Load patient data (only after PIN verified or no PIN needed)
  useEffect(() => {
    if (!token || !pinVerified) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    portalApi
      .get(`/patient-portal/${token}`, { signal: ctrl.signal })
      .then(({ data }) => {
        setPatient(data.patient);
        setStudies(data.studies);
        setShare(data.share);
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          const status = err?.response?.status;
          if (status === 410) {
            setError("This link has expired or been revoked. Please contact the clinic for a new link.");
          } else if (status === 404) {
            setError("This link is invalid. Please check the link or contact the clinic.");
          } else {
            setError(err?.response?.data?.detail ?? "Unable to load your records. Please try again later.");
          }
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [token, pinVerified]);

  const handlePinSubmit = async () => {
    if (!token || pinValue.length < 4) return;
    setPinSubmitting(true);
    setPinError("");
    try {
      await portalApi.post(`/patient-portal/${token}/verify-pin`, { pin: pinValue });
      setPinVerified(true);
      setNeedsPin(false);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { detail?: string } } };
      if (e?.response?.status === 401) {
        setPinError("Incorrect PIN. Please try again.");
      } else {
        setPinError(e?.response?.data?.detail ?? "Verification failed. Please try again.");
      }
    } finally {
      setPinSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-destructive">Invalid portal link</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const ptag = (key: keyof PatientData["MainDicomTags"]) =>
    patient?.MainDicomTags?.[key] || "";

  const stag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  const handleDownload = async (studyId: string) => {
    setDownloading(studyId);
    try {
      const res = await portalApi.get(`/patient-portal/${token}/download/${studyId}`, {
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
    } finally {
      setDownloading(null);
    }
  };

  const clinicName = clinicSettings.clinic_name || "Medical Imaging Portal";
  const sex = ptag("PatientSex");

  // PIN gate screen
  if (needsPin === true && !pinVerified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-sm mx-4 shadow-lg">
          <CardContent className="pt-8 pb-6 text-center space-y-6">
            <div className="flex justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Lock className="h-6 w-6 text-primary" />
              </div>
            </div>
            <div>
              <h2 className="text-lg font-semibold">{clinicName}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Enter your PIN to access your records
              </p>
            </div>
            <div className="space-y-3">
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="Enter PIN"
                value={pinValue}
                onChange={(e) => {
                  setPinValue(e.target.value.replace(/\D/g, ""));
                  setPinError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && handlePinSubmit()}
                className="text-center text-2xl tracking-[0.5em] h-14 font-mono"
                autoFocus
              />
              {pinError && (
                <p className="text-sm text-destructive">{pinError}</p>
              )}
            </div>
            <Button
              onClick={handlePinSubmit}
              className="w-full"
              disabled={pinValue.length < 4 || pinSubmitting}
            >
              {pinSubmitting ? "Verifying..." : "Access Records"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center space-y-3">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-muted-foreground">Loading your records...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md mx-4">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <Shield className="h-6 w-6 text-destructive" />
            </div>
            <div>
              <p className="font-semibold text-lg">Unable to Access Records</p>
              <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            </div>
            {(clinicSettings.clinic_phone || clinicSettings.clinic_email) && (
              <div className="pt-2 border-t space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Contact the clinic:</p>
                {clinicSettings.clinic_phone && (
                  <a href={`tel:${clinicSettings.clinic_phone}`} className="flex items-center justify-center gap-1 text-sm text-primary hover:underline">
                    <Phone className="h-3 w-3" /> {clinicSettings.clinic_phone}
                  </a>
                )}
                {clinicSettings.clinic_email && (
                  <a href={`mailto:${clinicSettings.clinic_email}`} className="flex items-center justify-center gap-1 text-sm text-primary hover:underline">
                    <Mail className="h-3 w-3" /> {clinicSettings.clinic_email}
                  </a>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-muted-foreground">Patient not found</p>
      </div>
    );
  }

  // Map modality to left border color
  const modalityBorderColor = (mod: string): string => {
    const m = mod.split("\\")[0]?.trim().toUpperCase();
    switch (m) {
      case "MR": return "border-l-blue-500";
      case "CT": return "border-l-amber-500";
      case "CR": case "DX": return "border-l-green-500";
      case "US": return "border-l-purple-500";
      case "XA": return "border-l-red-500";
      case "MG": return "border-l-pink-500";
      case "NM": case "PT": return "border-l-orange-500";
      default: return "border-l-gray-300";
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-semibold">{clinicName}</h1>
              <p className="text-xs text-muted-foreground">Secure Patient Portal</p>
            </div>
          </div>
          {share?.expires_at && (
            <p className="text-xs text-muted-foreground">
              Link expires {formatTimestamp(share.expires_at)}
            </p>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 sm:px-6 py-8 space-y-8">
        {/* Welcome */}
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Hello, {formatDicomName(ptag("PatientName"))}
          </h2>
          <p className="mt-1 text-muted-foreground">
            Your imaging records are available below. You can view them online or download for your records.
          </p>
        </div>

        {/* Patient Info */}
        <Card className="bg-white">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex items-start gap-3">
                <User className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Patient ID</p>
                  <p className="font-mono text-sm">{ptag("PatientID") || "\u2014"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Calendar className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Date of Birth</p>
                  <p className="text-sm">{formatDicomDate(ptag("PatientBirthDate"))}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Sex</p>
                <p className="text-sm">{sex === "M" ? "Male" : sex === "F" ? "Female" : sex || "\u2014"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Studies</p>
                <p className="text-sm font-medium">{studies.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Studies */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Your Imaging Studies</h3>

          {studies.length === 0 ? (
            <Card className="bg-white">
              <CardContent className="py-12 text-center text-muted-foreground">
                No imaging studies are available at this time.
              </CardContent>
            </Card>
          ) : (
            studies.map((s) => {
              const studyInstanceUID = stag(s, "StudyInstanceUID");
              const isViewing = viewingStudy === s.ID;
              const modality = stag(s, "ModalitiesInStudy");
              const isDownloading = downloading === s.ID;
              return (
                <Card
                  key={s.ID}
                  className={`bg-white overflow-hidden border-l-4 ${modalityBorderColor(modality)}`}
                >
                  <CardContent className="p-0">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">
                            {stag(s, "StudyDescription") || "Imaging Study"}
                          </p>
                          {modality && (
                            <ModalityBadge modality={modality} className="shrink-0" />
                          )}
                        </div>
                        {stag(s, "InstitutionName") && (
                          <p className="text-xs text-muted-foreground">{stag(s, "InstitutionName")}</p>
                        )}
                        <p className="text-sm text-muted-foreground">
                          {formatDicomDate(stag(s, "StudyDate"))}
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                        {studyInstanceUID && (
                          <Button
                            className="w-full sm:w-auto"
                            variant={isViewing ? "default" : "outline"}
                            onClick={() => setViewingStudy(isViewing ? null : s.ID)}
                          >
                            {isViewing ? (
                              <><EyeOff className="mr-2 h-4 w-4" /> Close Viewer</>
                            ) : (
                              <><Eye className="mr-2 h-4 w-4" /> View Online</>
                            )}
                          </Button>
                        )}
                        <Button className="w-full sm:w-auto" variant="outline" onClick={() => handleDownload(s.ID)} disabled={isDownloading}>
                          <Download className="mr-2 h-4 w-4" />
                          {isDownloading ? "Downloading..." : "Download"}
                        </Button>
                      </div>
                    </div>
                    {isViewing && studyInstanceUID && (
                      <div className="border-t">
                        <OhifViewer studyInstanceUID={studyInstanceUID} className="h-[400px] sm:h-[600px] w-full" />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t bg-white py-6 mt-8">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 text-center space-y-2">
          {(clinicSettings.clinic_phone || clinicSettings.clinic_email) && (
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-6 text-sm">
              {clinicSettings.clinic_phone && (
                <a href={`tel:${clinicSettings.clinic_phone}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                  <Phone className="h-3.5 w-3.5" /> {clinicSettings.clinic_phone}
                </a>
              )}
              {clinicSettings.clinic_email && (
                <a href={`mailto:${clinicSettings.clinic_email}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                  <Mail className="h-3.5 w-3.5" /> {clinicSettings.clinic_email}
                </a>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Your records are transmitted securely. This link is personal — do not share it with others.
          </p>
        </div>
      </footer>
    </div>
  );
}
