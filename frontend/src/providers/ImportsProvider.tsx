/* Global manager for in-flight imports.
 *
 * One Provider mounted at AppLayout owns every active upload, so
 * dropping a second batch while the first is still uploading no
 * longer kills the in-flight one (the bug the user hit before:
 * single dropFiles slot in AppLayout state would overwrite).
 *
 * Each call to `start(files)` creates a fresh job_id on the server
 * and spawns a detached runUpload() that survives dialog open/close
 * cycles. Pulling progress is done with `useImports()` — components
 * subscribe to the slice they care about.
 */
import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from "react";
import api from "@/lib/api";
import { runUpload, buildInitialProgress, type FileProgress } from "@/lib/chunkedUpload";
import { toast } from "sonner";

export interface LocalUploadState {
  jobId: string;
  sourceLabel: string;
  files: FileProgress[];
  totalBytes: number;
  startedAt: number;
  uploading: boolean;       // Phase 1-3 still running
  cancelled: boolean;
}

interface ImportsContextValue {
  uploads: Record<string, LocalUploadState>;
  /** Start a fresh import. Returns the new job_id once start-job
   *  succeeds — by that point an internal detached task is already
   *  driving uploads. */
  start: (files: File[], opts?: { silent?: boolean }) => Promise<string>;
  /** Stop sending new chunks for a local job, then DELETE it. The
   *  detached task observes the cancel token and stops on its next
   *  chunk boundary. */
  cancelLocal: (jobId: string) => Promise<void>;
  /** Pull the in-memory progress for a given job. Components use
   *  this to render per-file rows in dialogs and the pill. */
  getLocal: (jobId: string) => LocalUploadState | undefined;
}

const ImportsContext = createContext<ImportsContextValue | null>(null);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function buildSourceLabel(files: File[]): string {
  if (files.length === 0) return "";
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const names = files.length <= 3
    ? files.map((f) => f.name).join(", ")
    : `${files.slice(0, 2).map((f) => f.name).join(", ")} + ${files.length - 2} more`;
  return `${names} · ${fmtBytes(totalBytes)}`;
}

export function ImportsProvider({ children }: { children: React.ReactNode }) {
  const [uploads, setUploads] = useState<Record<string, LocalUploadState>>({});
  // Stash cancel tokens outside React state — they're plain mutable refs
  // observed by the detached uploader, no re-render needed when set.
  const cancelTokens = useRef<Record<string, { cancelled: boolean }>>({});

  const patch = useCallback((jobId: string, mut: (s: LocalUploadState) => LocalUploadState) => {
    setUploads((prev) => {
      const cur = prev[jobId];
      if (!cur) return prev;
      return { ...prev, [jobId]: mut(cur) };
    });
  }, []);

  const patchFile = useCallback((jobId: string, idx: number, p: Partial<FileProgress>) => {
    patch(jobId, (s) => {
      const next = s.files.slice();
      next[idx] = { ...next[idx], ...p };
      return { ...s, files: next };
    });
  }, [patch]);

  const start = useCallback(async (files: File[], opts?: { silent?: boolean }): Promise<string> => {
    if (files.length === 0) throw new Error("no files");
    const sourceLabel = buildSourceLabel(files);
    const totalBytes = files.reduce((a, f) => a + f.size, 0);

    const { data } = await api.post<{ job_id: string }>(
      "/studies/import/start-job",
      { source_label: sourceLabel },
    );
    const jobId = data.job_id;
    const initial: LocalUploadState = {
      jobId,
      sourceLabel,
      files: buildInitialProgress(files),
      totalBytes,
      startedAt: Date.now() / 1000,
      uploading: true,
      cancelled: false,
    };
    setUploads((prev) => ({ ...prev, [jobId]: initial }));
    const token = { cancelled: false };
    cancelTokens.current[jobId] = token;

    if (!opts?.silent) {
      toast.success(`Import started: ${sourceLabel}`);
    }

    // Detached: never await this from the caller. Errors are surfaced
    // through file-level status patches.
    void (async () => {
      try {
        await runUpload({
          files,
          jobId,
          cancelToken: token,
          callbacks: {
            onFile: (idx, p) => patchFile(jobId, idx, p),
            onDone: () => patch(jobId, (s) => ({ ...s, uploading: false })),
            onCancelled: () => patch(jobId, (s) => ({ ...s, uploading: false, cancelled: true })),
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Upload pipeline failed: ${msg}`);
        patch(jobId, (s) => ({ ...s, uploading: false }));
      }
    })();

    return jobId;
  }, [patch, patchFile]);

  const cancelLocal = useCallback(async (jobId: string) => {
    const token = cancelTokens.current[jobId];
    if (token) token.cancelled = true;
    patch(jobId, (s) => ({ ...s, cancelled: true }));
    try {
      await api.delete(`/studies/import/${jobId}`);
    } catch (e: unknown) {
      // Server may have already flipped to terminal (sweeper, race).
      // 409 is expected — surface only unexpected failures.
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status !== 409 && status !== 404) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Cancel failed: ${msg}`);
      }
    }
  }, [patch]);

  const getLocal = useCallback((jobId: string) => uploads[jobId], [uploads]);

  const value = useMemo<ImportsContextValue>(
    () => ({ uploads, start, cancelLocal, getLocal }),
    [uploads, start, cancelLocal, getLocal],
  );

  return <ImportsContext.Provider value={value}>{children}</ImportsContext.Provider>;
}

export function useImports(): ImportsContextValue {
  const ctx = useContext(ImportsContext);
  if (!ctx) throw new Error("useImports must be used inside <ImportsProvider>");
  return ctx;
}
