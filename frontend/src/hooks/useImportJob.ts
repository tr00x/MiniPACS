import { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export interface ImportJobStatus {
  job_id: string;
  status: "queued" | "extracting" | "uploading" | "done" | "error";
  total_files: number;
  processed: number;
  failed: number;
  errors: string[];
  current_file: string;
  studies_created: number;
  study_ids: string[];
  started_at: number;
  finished_at: number | null;
  elapsed_seconds: number;
}

export interface UseImportJobResult {
  status: ImportJobStatus | null;
  uploading: boolean;          // true while the initial POST is in flight
  progressPct: number;         // 0..100
  error: string | null;
  submit: (files: File[]) => Promise<void>;
  reset: () => void;
}

/** Drive one drag-and-drop import: upload files, poll status until terminal. */
export function useImportJob(): UseImportJobResult {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ImportJobStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearPoll = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const reset = useCallback(() => {
    clearPoll();
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus(null);
    setUploading(false);
    setError(null);
  }, []);

  const poll = useCallback(async (job_id: string) => {
    try {
      const { data } = await api.get<ImportJobStatus>(`/studies/import/${job_id}`);
      setStatus(data);
      if (data.status === "done" || data.status === "error") {
        clearPoll();
        qc.invalidateQueries({ queryKey: ["studies"] });
        qc.invalidateQueries({ queryKey: ["patients"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        return;
      }
      // Exponential-ish — fast at first, settle at 1.5s for longer jobs.
      const delay = data.status === "extracting" ? 500 : 1500;
      pollTimer.current = setTimeout(() => poll(job_id), delay);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`polling failed: ${msg}`);
      clearPoll();
    }
  }, [qc]);

  const submit = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    reset();
    setUploading(true);
    setError(null);

    const form = new FormData();
    for (const f of files) {
      // Preserve any nested path the browser gave us (webkitdirectory drag),
      // backend strips it back down to basename but keeps the intent if the
      // archive itself is the relevant unit.
      const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      form.append("files", f, name);
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const { data } = await api.post<{ job_id: string; files_staged: number; bytes_staged: number }>(
        "/studies/import",
        form,
        { signal: ctrl.signal, headers: { "Content-Type": "multipart/form-data" } },
      );
      setUploading(false);
      // Seed a "queued" status so the UI has something to render before
      // the first poll lands.
      setStatus({
        job_id: data.job_id,
        status: "queued",
        total_files: 0,
        processed: 0,
        failed: 0,
        errors: [],
        current_file: "",
        studies_created: 0,
        study_ids: [],
        started_at: Date.now() / 1000,
        finished_at: null,
        elapsed_seconds: 0,
      });
      poll(data.job_id);
    } catch (e: unknown) {
      setUploading(false);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, [poll, reset]);

  useEffect(() => () => {
    clearPoll();
    abortRef.current?.abort();
  }, []);

  const progressPct =
    status && status.total_files > 0
      ? Math.round(((status.processed + status.failed) / status.total_files) * 100)
      : status?.status === "uploading" || status?.status === "extracting"
        ? 5
        : 0;

  return { status, uploading, progressPct, error, submit, reset };
}
