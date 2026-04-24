import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient, skipToken } from "@tanstack/react-query";
import api from "@/lib/api";

// ---------- Query keys ----------
// Central key factory so invalidations stay correct across files.
export const qk = {
  dashboard: () => ["dashboard"] as const,
  studies: (params: Record<string, unknown> = {}) => ["studies", params] as const,
  study: (id: string) => ["study", id, "full"] as const,
  patients: (params: Record<string, unknown> = {}) => ["patients", params] as const,
  patient: (id: string) => ["patient", id, "full"] as const,
  settings: () => ["settings"] as const,
  users: () => ["users"] as const,
  pacsNodes: () => ["pacs-nodes"] as const,
  viewers: () => ["viewers"] as const,
  transfers: (params: Record<string, unknown> = {}) => ["transfers", params] as const,
  shares: (params: Record<string, unknown> = {}) => ["shares", params] as const,
  audit: (params: Record<string, unknown> = {}) => ["audit", params] as const,
  reports: (studyId: string) => ["reports", studyId] as const,
  orthancPatients: () => ["orthanc-patients"] as const,
};

// ---------- Generic fetcher ----------
const get = async <T,>(path: string, params?: Record<string, unknown>): Promise<T> => {
  const { data } = await api.get<T>(path, { params });
  return data;
};

// ---------- Query hooks ----------

export function useDashboard() {
  return useQuery({
    queryKey: qk.dashboard(),
    queryFn: () => get<{
      stats: {
        patients_total: number;
        studies_total: number;
        studies_today: number;
        transfers_week: number;
        failed_transfers: number;
        unviewed_shares: number;
      };
      system_health: {
        orthanc: { status: "online" | "offline"; version?: string; storage_size?: string; dicom_aet?: string; count_studies?: number; count_instances?: number };
        last_received: string | null;
      };
      recent_transfers: any[];
      active_shares: any[];
      patients: any[];
    }>("/dashboard"),
    // Dashboard shows live Orthanc status and recent transfers. Raised from
    // 15s -> 60s to avoid hammering Orthanc while the user also has OHIF
    // open; backend cache TTL is 30s, so effective poll-to-origin is ~60s.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useStudies(params: {
  search?: string;
  modality?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: qk.studies(params),
    queryFn: () => get<{ items: any[]; total: number }>("/studies", params),
    placeholderData: (prev) => prev, // keep prior page visible while next one loads
  });
}

export function useStudyFull(id: string | undefined) {
  return useQuery({
    queryKey: qk.study(id ?? ""),
    queryFn: id
      ? () => get<{
          study: any;
          series: any[];
          pacs_nodes: any[];
          viewers: any[];
          reports: any[];
        }>(`/studies/${id}/full`)
      : skipToken,
  });
}

export function usePatients(params: { search?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: qk.patients(params),
    queryFn: () => get<{ items: any[]; total: number }>("/patients", params),
    placeholderData: (prev) => prev,
  });
}

export function usePatientFull(id: string | undefined) {
  return useQuery({
    queryKey: qk.patient(id ?? ""),
    queryFn: id
      ? () => get<{
          patient: any;
          studies: any[];
          shares: any[];
          transfers: any[];
        }>(`/patients/${id}/full`)
      : skipToken,
  });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings(), queryFn: () => get<any>("/settings") });
}

export function useUsers() {
  return useQuery({ queryKey: qk.users(), queryFn: () => get<any[]>("/users") });
}

export function usePacsNodes() {
  return useQuery({ queryKey: qk.pacsNodes(), queryFn: () => get<any[]>("/pacs-nodes") });
}

export function useViewers() {
  return useQuery({ queryKey: qk.viewers(), queryFn: () => get<any[]>("/viewers") });
}

export function useTransfers(params: { limit?: number; study_id?: string } = {}) {
  return useQuery({
    queryKey: qk.transfers(params),
    queryFn: () => get<any>("/transfers", params),
  });
}

export function useShares(params: { patient_id?: string } = {}) {
  return useQuery({
    queryKey: qk.shares(params),
    queryFn: () => get<any>("/shares", params),
  });
}

export function useReports(studyId: string | undefined) {
  return useQuery({
    queryKey: qk.reports(studyId ?? ""),
    queryFn: studyId
      ? () => get<any[]>("/reports", { study_id: studyId })
      : skipToken,
  });
}

// ---------- Prefetch helpers (hover-to-warm) ----------
// When user hovers a row, kick off the detail fetch. By the time the click
// lands (100-300ms reaction), the backend cache is warm and the page paints
// instantly. Uses staleTime so repeated hovers in the same second don't spam.

export function usePrefetchStudyFull() {
  const qc = useQueryClient();
  return (id: string) => {
    if (!id) return;
    qc.prefetchQuery({
      queryKey: qk.study(id),
      queryFn: () => get<unknown>(`/studies/${id}/full`),
      staleTime: 30_000,
    });
  };
}

export function usePrefetchPatientFull() {
  const qc = useQueryClient();
  return (id: string) => {
    if (!id) return;
    qc.prefetchQuery({
      queryKey: qk.patient(id),
      queryFn: () => get<unknown>(`/patients/${id}/full`),
      staleTime: 30_000,
    });
  };
}

// ---------- Adjacent-study navigation ----------
// Resolve prev/next study IDs for the given patient + current study, and
// prefetch their full payload so keyboard n/p feels instant — navigation
// hits the React Query cache instead of the network.
//
// Ordering matches the portal's default list view: StudyDate desc (newest
// first). So `next` = older study, `prev` = newer study. This mirrors what
// the radiologist sees in the list.
export function useAdjacentStudies(patientId: string | undefined, currentStudyId: string) {
  const { data } = usePatientFull(patientId);
  const prefetch = usePrefetchStudyFull();

  const studies: Array<{ ID: string; MainDicomTags?: { StudyDate?: string } }> = data?.studies ?? [];
  const sorted = [...studies].sort((a, b) => {
    const da = a?.MainDicomTags?.StudyDate ?? "";
    const db = b?.MainDicomTags?.StudyDate ?? "";
    return db.localeCompare(da);
  });
  const idx = sorted.findIndex((s) => s.ID === currentStudyId);
  const prev = idx > 0 ? sorted[idx - 1].ID : null;
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1].ID : null;

  useEffect(() => {
    if (next) prefetch(next);
    if (prev) prefetch(prev);
  }, [next, prev, prefetch]);

  return { next, prev };
}

// ---------- Invalidation helpers ----------
// All invalidations here use PREFIX match (default react-query behavior): e.g.
// invalidate.studies() busts ["studies"], ["studies",{limit:50,...}] and so on.
// If you need an exact match, use qc directly with { exact: true }.
export function useInvalidate() {
  const qc = useQueryClient();
  const invalidate = {
    dashboard: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
    studies: () => qc.invalidateQueries({ queryKey: ["studies"] }),
    study: (id: string) => qc.invalidateQueries({ queryKey: ["study", id] }),
    patients: () => qc.invalidateQueries({ queryKey: ["patients"] }),
    patient: (id: string) => qc.invalidateQueries({ queryKey: ["patient", id] }),
    pacsNodes: () => qc.invalidateQueries({ queryKey: qk.pacsNodes() }),
    viewers: () => qc.invalidateQueries({ queryKey: qk.viewers() }),
    settings: () => qc.invalidateQueries({ queryKey: qk.settings() }),
    users: () => qc.invalidateQueries({ queryKey: qk.users() }),
    transfers: () => qc.invalidateQueries({ queryKey: ["transfers"] }),
    shares: () => qc.invalidateQueries({ queryKey: ["shares"] }),
    reports: (studyId: string) => qc.invalidateQueries({ queryKey: qk.reports(studyId) }),

    // --- Convenience bundles for common mutation flows ---
    // Share create/edit/revoke touches: patient.shares, patient.transfers,
    // dashboard.active_shares, dashboard.stats.unviewed_shares, and the
    // standalone shares list.
    afterShareChange: (patientId?: string) => {
      if (patientId) qc.invalidateQueries({ queryKey: ["patient", patientId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["shares"] });
    },
    // Any change to PACS nodes ripples into study/full (Send-to-PACS menu),
    // transfers (node name column), and dashboard.recent_transfers.
    afterPacsNodeChange: () => {
      qc.invalidateQueries({ queryKey: qk.pacsNodes() });
      qc.invalidateQueries({ queryKey: ["study"] });
      qc.invalidateQueries({ queryKey: ["transfers"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    // WARNING: refetches EVERY active query. Use only from the Settings page
    // "Reload everything" button, never inside a per-mutation handler.
    all: () => qc.invalidateQueries(),
  } as const;
  return invalidate;
}

// Re-export for convenience so pages can `import { useMutation } from "@/hooks/queries"`
export { useMutation };
