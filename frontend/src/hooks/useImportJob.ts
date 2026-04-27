import { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export interface ImportJobStatus {
  job_id: string;
  user_id?: number;
  status: "queued" | "extracting" | "uploading" | "done" | "error";
  total_files: number;
  processed: number;
  failed: number;
  new_instances: number;
  duplicate_instances: number;
  errors: string[];
  current_file: string;
  studies_created: number;
  study_ids: string[];
  upload_ids: string[];
  started_at: number;
  finished_at: number | null;
  elapsed_seconds: number;
}

export interface UseImportJobResult {
  status: ImportJobStatus | null;
  progressPct: number;
  error: string | null;
  startJob: () => Promise<string>;       // creates job_id up front
  attach: (jobId: string) => void;       // start polling an existing job (read-only mode)
  retry: (jobId: string) => Promise<void>;
  reset: () => void;
}

export function useImportJob(): UseImportJobResult {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ImportJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentJobRef = useRef<string | null>(null);

  const clearPoll = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
  };

  const reset = useCallback(() => {
    clearPoll();
    currentJobRef.current = null;
    setStatus(null);
    setError(null);
  }, []);

  const poll = useCallback(async (jobId: string) => {
    if (currentJobRef.current !== jobId) return;
    try {
      const { data } = await api.get<ImportJobStatus>(`/studies/import/${jobId}`);
      setStatus(data);
      if (data.status === "done" || data.status === "error") {
        clearPoll();
        qc.invalidateQueries({ queryKey: ["studies"] });
        qc.invalidateQueries({ queryKey: ["patients"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        return;
      }
      pollTimer.current = setTimeout(() => poll(jobId), 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`polling failed: ${msg}`);
      clearPoll();
    }
  }, [qc]);

  const startJob = useCallback(async (): Promise<string> => {
    reset();
    const { data } = await api.post<{ job_id: string }>("/studies/import/start-job");
    currentJobRef.current = data.job_id;
    setStatus({
      job_id: data.job_id,
      status: "queued",
      total_files: 0, processed: 0, failed: 0,
      new_instances: 0, duplicate_instances: 0,
      errors: [], current_file: "",
      studies_created: 0, study_ids: [], upload_ids: [],
      started_at: Date.now() / 1000, finished_at: null, elapsed_seconds: 0,
    });
    poll(data.job_id);
    return data.job_id;
  }, [poll, reset]);

  const attach = useCallback((jobId: string) => {
    reset();
    currentJobRef.current = jobId;
    poll(jobId);
  }, [poll, reset]);

  const retry = useCallback(async (jobId: string) => {
    await api.post(`/studies/import/${jobId}/retry`);
    if (currentJobRef.current !== jobId) attach(jobId);
  }, [attach]);

  useEffect(() => () => {
    clearPoll();
  }, []);

  const progressPct =
    status && status.total_files > 0
      ? Math.round(((status.processed + status.failed) / status.total_files) * 100)
      : status?.status === "uploading" || status?.status === "extracting"
        ? 5
        : 0;

  return { status, progressPct, error, startJob, attach, retry, reset };
}
