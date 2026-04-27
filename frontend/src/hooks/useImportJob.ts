import { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export interface FileError {
  name: string;
  reason: string;
  kind?: string;       // extract | format | empty | pacs_reject | internal
  http?: number;
  ts?: number;
}

export interface ImportJobStatus {
  job_id: string;
  user_id?: number;
  status: "queued" | "extracting" | "uploading" | "done" | "error" | "cancelled";
  source_label: string;
  total_files: number;
  processed: number;
  failed: number;
  new_instances: number;
  duplicate_instances: number;
  errors: string[];
  file_errors: FileError[];
  current_file: string;
  studies_created: number;
  study_ids: string[];
  upload_ids: string[];
  started_at: number;
  finished_at: number | null;
  last_progress_at: number;
  elapsed_seconds: number;
}

export interface UploadsProgress {
  chunks_total: number;
  chunks_received: number;
  bytes_total: number;
  bytes_received_est: number;
  files: {
    upload_id: string;
    name: string;
    size: number;
    total_chunks: number;
    received_chunks: number;
  }[];
}

export interface UseImportJobResult {
  status: ImportJobStatus | null;
  progressPct: number;
  uploads: UploadsProgress | null;
  error: string | null;
  startJob: (sourceLabel?: string) => Promise<string>;  // creates job_id up front
  attach: (jobId: string) => void;       // start polling an existing job (read-only mode)
  retry: (jobId: string) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  reset: () => void;
}

export const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export function isTerminal(s: ImportJobStatus["status"]): boolean {
  return TERMINAL_STATUSES.has(s);
}

export function useImportJob(): UseImportJobResult {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ImportJobStatus | null>(null);
  const [uploads, setUploads] = useState<UploadsProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentJobRef = useRef<string | null>(null);

  const clearTimers = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
    if (uploadsTimer.current) { clearTimeout(uploadsTimer.current); uploadsTimer.current = null; }
  };

  const reset = useCallback(() => {
    clearTimers();
    currentJobRef.current = null;
    setStatus(null);
    setUploads(null);
    setError(null);
  }, []);

  // Separate poller for chunk-receipt progress. Runs while the job is
  // pre-processing (status='queued') so the UI can show real upload %
  // even before the server starts work. Stops polling once any
  // upload_id has been finalized (chunks_total starts shrinking) — at
  // that point the file is gone from staging and the main job poller
  // takes over with total_files/processed.
  const pollUploads = useCallback(async (jobId: string) => {
    if (currentJobRef.current !== jobId) return;
    try {
      const { data } = await api.get<UploadsProgress>(`/studies/import/${jobId}/uploads-progress`);
      setUploads(data);
    } catch {
      // Endpoint may not exist on older backends — fail silently, the
      // main poller carries on.
    }
    // Slower cadence than job poll — chunks land aggressively, no need
    // to hammer the staging API.
    uploadsTimer.current = setTimeout(() => pollUploads(jobId), 2000);
  }, []);

  const poll = useCallback(async (jobId: string) => {
    if (currentJobRef.current !== jobId) return;
    try {
      const { data } = await api.get<ImportJobStatus>(`/studies/import/${jobId}`);
      setStatus(data);
      if (isTerminal(data.status)) {
        clearTimers();
        qc.invalidateQueries({ queryKey: ["studies"] });
        qc.invalidateQueries({ queryKey: ["patients"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.invalidateQueries({ queryKey: ["imports"] });
        return;
      }
      pollTimer.current = setTimeout(() => poll(jobId), 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`polling failed: ${msg}`);
      clearTimers();
    }
  }, [qc]);

  const startJob = useCallback(async (sourceLabel?: string): Promise<string> => {
    reset();
    const { data } = await api.post<{ job_id: string }>(
      "/studies/import/start-job",
      { source_label: sourceLabel || "" },
    );
    currentJobRef.current = data.job_id;
    const now = Date.now() / 1000;
    setStatus({
      job_id: data.job_id,
      status: "queued",
      source_label: sourceLabel || "",
      total_files: 0, processed: 0, failed: 0,
      new_instances: 0, duplicate_instances: 0,
      errors: [], file_errors: [], current_file: "",
      studies_created: 0, study_ids: [], upload_ids: [],
      started_at: now, finished_at: null,
      last_progress_at: now, elapsed_seconds: 0,
    });
    poll(data.job_id);
    pollUploads(data.job_id);
    return data.job_id;
  }, [poll, pollUploads, reset]);

  const attach = useCallback((jobId: string) => {
    reset();
    currentJobRef.current = jobId;
    poll(jobId);
    pollUploads(jobId);
  }, [poll, pollUploads, reset]);

  const retry = useCallback(async (jobId: string) => {
    await api.post(`/studies/import/${jobId}/retry`);
    if (currentJobRef.current !== jobId) attach(jobId);
  }, [attach]);

  const cancel = useCallback(async (jobId: string) => {
    await api.delete(`/studies/import/${jobId}`);
    // Re-poll once so the dialog flips to the cancelled-terminal view
    // immediately rather than waiting for the next 1.5s tick.
    if (currentJobRef.current === jobId) {
      try {
        const { data } = await api.get<ImportJobStatus>(`/studies/import/${jobId}`);
        setStatus(data);
      } catch {
        // ignore, the regular poll loop will catch up
      }
    }
    qc.invalidateQueries({ queryKey: ["imports"] });
  }, [qc]);

  useEffect(() => () => {
    clearTimers();
  }, []);

  // Progress: prefer real chunk-progress while uploads are still being
  // received; switch to processed/total once the server starts work.
  const progressPct = (() => {
    if (!status) return 0;
    if (status.total_files > 0) {
      return Math.round(((status.processed + status.failed) / status.total_files) * 100);
    }
    if (uploads && uploads.chunks_total > 0) {
      return Math.round((uploads.chunks_received / uploads.chunks_total) * 100);
    }
    if (status.status === "uploading" || status.status === "extracting") return 5;
    return 0;
  })();

  return { status, progressPct, uploads, error, startJob, attach, retry, cancel, reset };
}
