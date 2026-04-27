import { useCallback, useRef, useState } from "react";
import api from "@/lib/api";

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB — small enough for nginx 10M cap, large enough to amortize HTTP RTT
const MAX_PARALLEL_FILES = 3;
const MAX_PARALLEL_CHUNKS_PER_FILE = 2;

export interface FileProgress {
  name: string;
  size: number;
  bytes_sent: number;
  status: "pending" | "hashing" | "checking" | "uploading" | "finalizing" | "done" | "skipped" | "error";
  error?: string;
  duplicate_instances?: number;  // populated when status === 'skipped' (precheck)
}

export interface UseChunkedUploadResult {
  files: FileProgress[];
  uploading: boolean;
  totalBytes: number;
  bytesSent: number;
  start: (files: File[], jobId: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

async function sha256OfFile(file: File, onProgress?: (bytes: number) => void): Promise<string> {
  // WebCrypto digest is one-shot — to keep memory bounded for 5 GB files we
  // hash chunk-by-chunk and combine. Since SubtleCrypto has no incremental
  // API, we accumulate all chunks of an ArrayBuffer first and digest once;
  // memory peak == file size, which is fine in practice for our cap (20 GB
  // job total but per-file usually <2 GB CD-ISO). For files >500 MB we
  // could swap to a streaming WASM SHA-256 later.
  const buf = await file.arrayBuffer();
  onProgress?.(file.size);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

export function useChunkedUpload(): UseChunkedUploadResult {
  const [files, setFiles] = useState<FileProgress[]>([]);
  const [uploading, setUploading] = useState(false);
  const cancelRef = useRef<boolean>(false);

  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const bytesSent = files.reduce((a, f) => a + f.bytes_sent, 0);

  const reset = useCallback(() => {
    cancelRef.current = false;
    setFiles([]);
    setUploading(false);
  }, []);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const updateFile = useCallback((idx: number, patch: Partial<FileProgress>) => {
    setFiles((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const uploadOne = useCallback(async (file: File, idx: number, jobId: string, sha256: string) => {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    updateFile(idx, { status: "uploading" });

    // Create the upload (or fetch existing — we don't reuse here, but resume
    // could be added by storing upload_id in localStorage keyed by hash).
    const { data: created } = await api.post<{ upload_id: string }>(
      "/studies/import/uploads",
      { job_id: jobId, name: file.name, size: file.size, sha256, total_chunks: totalChunks },
    );
    const uploadId = created.upload_id;

    // Discover what's already there (always [] for fresh upload, but the
    // GET supports the resume scenario after page reload).
    const { data: status } = await api.get<{ received_chunks: number[] }>(
      `/studies/import/uploads/${uploadId}`,
    );
    const have = new Set(status.received_chunks);
    const need: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!have.has(i)) need.push(i);
      else updateFile(idx, {});  // already-have chunks count toward bytes_sent below
    }
    let sent = have.size * CHUNK_SIZE;
    if (sent > file.size) sent = file.size;
    updateFile(idx, { bytes_sent: sent });

    const sendOne = async (chunkIdx: number) => {
      if (cancelRef.current) return;
      const start = chunkIdx * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);
      // Use fetch for binary PUT — axios converts ArrayBuffer to JSON if
      // headers aren't right, fetch is more predictable for raw bytes.
      const token = localStorage.getItem("access_token");
      const res = await fetch(
        `/api/studies/import/uploads/${uploadId}/chunks/${chunkIdx}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: blob,
        },
      );
      if (!res.ok) throw new Error(`chunk ${chunkIdx}: HTTP ${res.status}`);
      sent += end - start;
      updateFile(idx, { bytes_sent: Math.min(sent, file.size) });
    };

    // Bounded parallelism per file.
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < MAX_PARALLEL_CHUNKS_PER_FILE; w++) {
      workers.push((async () => {
        while (cursor < need.length) {
          const myIdx = cursor++;
          if (myIdx >= need.length) break;
          await sendOne(need[myIdx]);
        }
      })());
    }
    await Promise.all(workers);

    if (cancelRef.current) {
      updateFile(idx, { status: "error", error: "cancelled" });
      return;
    }

    updateFile(idx, { status: "finalizing" });
    await api.post("/studies/import/finalize", { upload_id: uploadId });
    updateFile(idx, { status: "done" });
  }, [updateFile]);

  const start = useCallback(async (rawFiles: File[], jobId: string) => {
    if (rawFiles.length === 0) return;
    setUploading(true);
    cancelRef.current = false;
    const initial: FileProgress[] = rawFiles.map((f) => ({
      name: f.name, size: f.size, bytes_sent: 0, status: "pending",
    }));
    setFiles(initial);

    // Phase 1: hash all files (sequentially, to avoid memory pressure on
    // large drops; main-thread blocking acceptable for now).
    const hashes: string[] = [];
    for (let i = 0; i < rawFiles.length; i++) {
      if (cancelRef.current) { setUploading(false); return; }
      updateFile(i, { status: "hashing" });
      const h = await sha256OfFile(rawFiles[i]);
      hashes.push(h);
    }

    // Phase 2: precheck
    if (cancelRef.current) { setUploading(false); return; }
    rawFiles.forEach((_, i) => updateFile(i, { status: "checking" }));
    const { data: pre } = await api.post<{
      results: Record<string, { action: string; instance_count: number; study_ids: string[] }>;
    }>("/studies/import/precheck", {
      files: rawFiles.map((f, i) => ({ name: f.name, size: f.size, sha256: hashes[i] })),
    });

    // Phase 3: upload only files that came back as "upload"
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const queue = rawFiles.map((f, i) => ({ f, i, sha: hashes[i] }));

    // Mark skipped files immediately.
    queue.forEach(({ i, sha }) => {
      const r = pre.results[sha];
      if (r?.action === "skip") {
        updateFile(i, {
          status: "skipped",
          bytes_sent: rawFiles[i].size,
          duplicate_instances: r.instance_count,
        });
      }
    });
    const todo = queue.filter(({ sha }) => pre.results[sha]?.action !== "skip");

    for (let w = 0; w < MAX_PARALLEL_FILES; w++) {
      workers.push((async () => {
        while (cursor < todo.length) {
          const my = cursor++;
          if (my >= todo.length) break;
          const { f, i, sha } = todo[my];
          try {
            await uploadOne(f, i, jobId, sha);
          } catch (e: unknown) {
            updateFile(i, {
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      })());
    }
    await Promise.all(workers);
    setUploading(false);
  }, [uploadOne, updateFile]);

  return { files, uploading, totalBytes, bytesSent, start, cancel, reset };
}
