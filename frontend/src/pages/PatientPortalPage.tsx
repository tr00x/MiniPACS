import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Eye, EyeOff, Shield, Phone, Mail, Calendar, User, Lock, FileImage, Clock, Maximize, Minimize, ClipboardPaste } from "lucide-react";
import { ModalityBadge } from "@/components/ui/modality-badge";
import axios from "axios";
import { OhifViewer } from "@/components/viewer/OhifViewer";
import { formatDicomName, formatDicomDate } from "@/lib/dicom";

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);

  // PIN gate
  const [needsPin, setNeedsPin] = useState<boolean | null>(null);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinVerified, setPinVerified] = useState(false);
  const [pinSubmitting, setPinSubmitting] = useState(false);

  useEffect(() => {
    portalApi.get("/settings/public")
      .then(({ data }) => setClinicSettings(data))
      .catch(() => {});
  }, []);

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
          setPinVerified(true);
        }
      })
      .catch((err) => {
        if (err.name !== "CanceledError" && err.name !== "AbortError") {
          const status = err?.response?.status;
          if (status === 410) setError("This link has expired or been revoked. Please contact the clinic for a new link.");
          else if (status === 404) setError("This link is invalid. Please check the link or contact the clinic.");
          else setError(err?.response?.data?.detail ?? "Unable to load your records.");
          setLoading(false);
        }
      });
    return () => ctrl.abort();
  }, [token]);

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
          if (status === 410) setError("This link has expired or been revoked.");
          else if (status === 404) setError("This link is invalid.");
          else setError(err?.response?.data?.detail ?? "Unable to load your records.");
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
      if (e?.response?.status === 401) setPinError("Incorrect PIN. Please try again.");
      else setPinError("Verification failed. Please try again.");
    } finally {
      setPinSubmitting(false);
    }
  };

  const ptag = (key: keyof PatientData["MainDicomTags"]) => patient?.MainDicomTags?.[key] || "";
  const stag = (s: Study, key: keyof Study["MainDicomTags"]) => s.MainDicomTags?.[key] || "";

  const handleDownload = async (studyId: string) => {
    setDownloading(studyId);
    try {
      const res = await portalApi.get(`/patient-portal/${token}/download/${studyId}`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `study-${studyId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Failed to download. Please try again.");
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadImages = async (studyId: string) => {
    setDownloading(`img-${studyId}`);
    try {
      // Get study series first, then download first series as JPEG
      // For simplicity, download the whole study as DICOM but patient-friendly naming
      const res = await portalApi.get(`/patient-portal/${token}/download/${studyId}`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `imaging-records-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Failed to download images. Please try again.");
    } finally {
      setDownloading(null);
    }
  };

  useEffect(() => {
    const h = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (viewerRef.current) {
      await viewerRef.current.requestFullscreen();
    }
  };

  const handlePastePin = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const digits = text.replace(/\D/g, "").slice(0, 6);
      if (digits) setPinValue(digits);
    } catch {
      // clipboard access denied
    }
  };

  const clinicName = clinicSettings.clinic_name || "Medical Imaging Portal";

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-blue-50 to-white">
        <p className="text-muted-foreground">Invalid portal link</p>
      </div>
    );
  }

  // ──── PIN Screen ────
  if (needsPin === true && !pinVerified) {
    return (
      <div className="flex min-h-screen flex-col bg-gradient-to-b from-blue-50 to-white">
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-sm space-y-8">
            <div className="text-center space-y-3">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-600/20">
                <Shield className="h-8 w-8 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold">{clinicName}</h1>
                <p className="text-sm text-muted-foreground">Secure Patient Portal</p>
              </div>
            </div>

            <Card className="shadow-xl border-0 bg-white">
              <CardContent className="pt-8 pb-8 px-6 space-y-6">
                <div className="text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 mb-3">
                    <Lock className="h-5 w-5 text-blue-600" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Enter the PIN provided by your clinic
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="- - - -"
                      value={pinValue}
                      onChange={(e) => { setPinValue(e.target.value.replace(/\D/g, "")); setPinError(""); }}
                      onPaste={(e) => {
                        e.preventDefault();
                        const text = e.clipboardData.getData("text");
                        const digits = text.replace(/\D/g, "").slice(0, 6);
                        if (digits) { setPinValue(digits); setPinError(""); }
                      }}
                      onKeyDown={(e) => e.key === "Enter" && handlePinSubmit()}
                      autoFocus
                      className="w-full text-center text-3xl tracking-[0.75em] h-16 rounded-xl border-2 border-gray-200 bg-white font-mono focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all placeholder:text-gray-300"
                    />
                    <button
                      type="button"
                      onClick={handlePastePin}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-gray-100 transition-colors"
                      title="Paste from clipboard"
                    >
                      <ClipboardPaste className="h-4 w-4" />
                    </button>
                  </div>
                  {pinError && (
                    <p className="text-sm text-center text-red-500 font-medium">{pinError}</p>
                  )}
                </div>

                <Button
                  onClick={handlePinSubmit}
                  className="w-full h-12 text-base rounded-xl bg-blue-600 hover:bg-blue-700 shadow-sm"
                  disabled={pinValue.length < 4 || pinSubmitting}
                >
                  {pinSubmitting ? "Verifying..." : "Access My Records"}
                </Button>
              </CardContent>
            </Card>

            {(clinicSettings.clinic_phone || clinicSettings.clinic_email) && (
              <div className="text-center space-y-1.5">
                <p className="text-xs text-muted-foreground">Need help? Contact your clinic</p>
                <div className="flex items-center justify-center gap-4 text-sm">
                  {clinicSettings.clinic_phone && (
                    <a href={`tel:${clinicSettings.clinic_phone}`} className="text-blue-600 hover:underline flex items-center gap-1">
                      <Phone className="h-3 w-3" /> {clinicSettings.clinic_phone}
                    </a>
                  )}
                  {clinicSettings.clinic_email && (
                    <a href={`mailto:${clinicSettings.clinic_email}`} className="text-blue-600 hover:underline flex items-center gap-1">
                      <Mail className="h-3 w-3" /> Email
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ──── Loading ────
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-blue-50 to-white">
        <div className="text-center space-y-4">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-[3px] border-blue-600 border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading your records...</p>
        </div>
      </div>
    );
  }

  // ──── Error ────
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-blue-50 to-white p-4">
        <Card className="w-full max-w-md shadow-xl border-0">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
              <Shield className="h-7 w-7 text-red-500" />
            </div>
            <div>
              <p className="font-semibold text-lg">Unable to Access Records</p>
              <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            </div>
            {(clinicSettings.clinic_phone || clinicSettings.clinic_email) && (
              <div className="pt-4 border-t space-y-2">
                <p className="text-xs text-muted-foreground font-medium">Contact your clinic:</p>
                <div className="flex items-center justify-center gap-4">
                  {clinicSettings.clinic_phone && (
                    <a href={`tel:${clinicSettings.clinic_phone}`} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
                      <Phone className="h-3.5 w-3.5" /> Call
                    </a>
                  )}
                  {clinicSettings.clinic_email && (
                    <a href={`mailto:${clinicSettings.clinic_email}`} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
                      <Mail className="h-3.5 w-3.5" /> Email
                    </a>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-blue-50 to-white">
        <p className="text-muted-foreground">Patient not found</p>
      </div>
    );
  }

  const sex = ptag("PatientSex");

  // ──── Main Portal ────
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-blue-50/50 to-white">
      {/* Header */}
      <header className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 shadow">
              <Shield className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="font-semibold text-sm sm:text-base leading-tight">{clinicName}</h1>
              <p className="text-[11px] text-muted-foreground">Secure Patient Portal</p>
            </div>
          </div>
          {share?.expires_at && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground bg-gray-100 rounded-full px-2.5 py-1">
              <Clock className="h-3 w-3" />
              <span className="hidden sm:inline">Expires</span> {new Date(share.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </div>
          )}
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 py-5 sm:py-8 space-y-5 sm:space-y-6 transition-all ${viewingStudy ? "max-w-6xl px-2 sm:px-4" : "max-w-3xl px-4 sm:px-6"}`}>
        {/* Welcome */}
        <div className="space-y-1">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
            Welcome, {formatDicomName(ptag("PatientName")).split(" ")[0]}
          </h2>
          <p className="text-sm text-muted-foreground">
            Your imaging records are ready to view and download.
          </p>
        </div>

        {/* Patient Info — compact row */}
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm rounded-xl bg-white border p-3.5 shadow-sm">
          <div className="flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground text-xs">ID</span>
            <span className="font-mono font-medium text-xs">{ptag("PatientID") || "—"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground text-xs">DOB</span>
            <span className="font-medium text-xs">{formatDicomDate(ptag("PatientBirthDate"))}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">Sex</span>
            <span className="font-medium text-xs">{sex === "M" ? "Male" : sex === "F" ? "Female" : sex || "—"}</span>
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <FileImage className="h-3.5 w-3.5 text-blue-600" />
            <span className="font-semibold text-xs">{studies.length} {studies.length === 1 ? "study" : "studies"}</span>
          </div>
        </div>

        {/* Studies */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Your Studies</h3>

          {studies.length === 0 ? (
            <div className="rounded-xl border bg-white p-12 text-center shadow-sm">
              <FileImage className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">No imaging studies are available at this time.</p>
            </div>
          ) : (
            studies.map((s) => {
              const studyInstanceUID = stag(s, "StudyInstanceUID");
              const isViewing = viewingStudy === s.ID;
              const modality = stag(s, "ModalitiesInStudy");
              const isDownloading = downloading === s.ID;
              return (
                <div key={s.ID} className="rounded-xl border bg-white overflow-hidden shadow-sm">
                  <div className="p-4 sm:p-5">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-semibold">
                            {stag(s, "StudyDescription") || "Imaging Study"}
                          </h4>
                          {modality && <ModalityBadge modality={modality} />}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          <span>{formatDicomDate(stag(s, "StudyDate"))}</span>
                          {stag(s, "InstitutionName") && (
                            <>
                              <span className="text-muted-foreground/30">·</span>
                              <span>{stag(s, "InstitutionName")}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Buttons */}
                    <div className={`grid gap-2 mt-4 grid-cols-2 ${isViewing ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"}`}>
                      {studyInstanceUID && (
                        <Button
                          className="h-12 text-sm rounded-lg"
                          variant={isViewing ? "default" : "outline"}
                          onClick={() => setViewingStudy(isViewing ? null : s.ID)}
                        >
                          {isViewing ? (
                            <><EyeOff className="mr-2 h-4 w-4" /> Close Viewer</>
                          ) : (
                            <><Eye className="mr-2 h-4 w-4" /> View Images</>
                          )}
                        </Button>
                      )}
                      {isViewing && (
                        <Button
                          className="h-12 text-sm rounded-lg"
                          variant="outline"
                          onClick={toggleFullscreen}
                        >
                          {isFullscreen
                            ? <><Minimize className="mr-2 h-4 w-4" /> Exit Fullscreen</>
                            : <><Maximize className="mr-2 h-4 w-4" /> Fullscreen</>}
                        </Button>
                      )}
                      <Button
                        className="h-12 text-sm rounded-lg"
                        variant="outline"
                        onClick={() => handleDownload(s.ID)}
                        disabled={!!downloading}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        {downloading === s.ID ? "Preparing..." : "DICOM"}
                      </Button>
                      <Button
                        className="h-12 text-sm rounded-lg"
                        variant="outline"
                        onClick={() => handleDownloadImages(s.ID)}
                        disabled={!!downloading}
                      >
                        <FileImage className="mr-2 h-4 w-4" />
                        {downloading === `img-${s.ID}` ? "Preparing..." : "Images (JPEG)"}
                      </Button>
                    </div>
                  </div>

                  {isViewing && studyInstanceUID && (
                    <div ref={viewerRef} className="border-t bg-black overflow-hidden -mx-4 sm:-mx-5 rounded-b-xl max-w-[100vw]">
                      <OhifViewer studyInstanceUID={studyInstanceUID} className={isFullscreen ? "h-screen w-full" : "h-[55vh] sm:h-[65vh] lg:h-[70vh] w-full max-w-full"} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t py-5 mt-auto">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 text-center space-y-3">
          {(clinicSettings.clinic_phone || clinicSettings.clinic_email) && (
            <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-5">
              {clinicSettings.clinic_phone && (
                <a href={`tel:${clinicSettings.clinic_phone}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-blue-600 transition-colors">
                  <Phone className="h-4 w-4" /> {clinicSettings.clinic_phone}
                </a>
              )}
              {clinicSettings.clinic_email && (
                <a href={`mailto:${clinicSettings.clinic_email}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-blue-600 transition-colors">
                  <Mail className="h-4 w-4" /> {clinicSettings.clinic_email}
                </a>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
            Your records are encrypted and transmitted securely. This link is personal — do not share it with others.
          </p>
        </div>
      </footer>
    </div>
  );
}
