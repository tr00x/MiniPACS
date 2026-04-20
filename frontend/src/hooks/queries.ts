import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
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
        orthanc: { status: "online" | "offline"; version?: string; storage_size?: string; dicom_aet?: string; count_instances?: number };
        last_received: string | null;
      };
      recent_transfers: any[];
      active_shares: any[];
      patients: any[];
    }>("/dashboard"),
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
    queryKey: id ? qk.study(id) : ["study", "__disabled__"],
    queryFn: () => get<{
      study: any;
      series: any[];
      pacs_nodes: any[];
      viewers: any[];
      reports: any[];
    }>(`/studies/${id}/full`),
    enabled: !!id,
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
    queryKey: id ? qk.patient(id) : ["patient", "__disabled__"],
    queryFn: () => get<{
      patient: any;
      studies: any[];
      shares: any[];
      transfers: any[];
    }>(`/patients/${id}/full`),
    enabled: !!id,
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
    queryKey: studyId ? qk.reports(studyId) : ["reports", "__disabled__"],
    queryFn: () => get<any[]>("/reports", { study_id: studyId }),
    enabled: !!studyId,
  });
}

// ---------- Invalidation helpers ----------
export function useInvalidate() {
  const qc = useQueryClient();
  return {
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
    all: () => qc.invalidateQueries(),
  };
}

// Re-export for convenience so pages can `import { useMutation } from "@/hooks/queries"`
export { useMutation };
