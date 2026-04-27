/* Pure async chunked-upload pipeline.
 *
 * Lifted out of useChunkedUpload so the global ImportsProvider can
 * drive several concurrent jobs without each one being tied to a
 * mounted React component. The hook still wraps this for the
 * single-dialog start-fresh path; the provider calls runUpload()
 * directly.
 *
 * Contract: caller owns state — runUpload() pushes deltas via the
 * `onProgress` callback (per-file bytes_sent / status / error /
 * dup_instances). Caller decides what to render.
 */
import api from "@/lib/api";

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_PARALLEL_FILES = 3;
const MAX_PARALLEL_CHUNKS_PER_FILE = 2;

export type FileStatus =
  | "pending" | "hashing" | "checking" | "uploading"
  | "finalizing" | "done" | "skipped" | "error";

export interface FileProgress {
  name: string;
  size: number;
  bytes_sent: number;
  status: FileStatus;
  error?: string;
  duplicate_instances?: number;
}

export interface UploadCallbacks {
  /** Called whenever a single file's progress changes — index into the
   *  initial list, partial patch. */
  onFile: (idx: number, patch: Partial<FileProgress>) => void;
  /** Called once when all phases complete (success or error per-file). */
  onDone?: () => void;
  /** Called when the cancel signal flips to true so the caller knows
   *  uploads stopped voluntarily, not via crash. */
  onCancelled?: () => void;
}

export interface UploadHandle {
  /** Stop sending new chunks. Already-in-flight requests still complete
   *  but no new ones are issued. The job remains on the server until
   *  the caller hits DELETE /import/{job_id}. */
  cancel: () => void;
}

async function sha256OfFile(file: File): Promise<string> {
  // SubtleCrypto.digest is one-shot — for files in our 20 GB cap we'd
  // need streaming, but in practice individual ISO/ZIP drops sit under
  // 4 GB and arrayBuffer() peaks at file size. Acceptable for now.
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface RunArgs {
  files: File[];
  jobId: string;
  callbacks: UploadCallbacks;
  cancelToken: { cancelled: boolean };
}

async function uploadOne(
  file: File, idx: number, jobId: string, sha256: string,
  cb: UploadCallbacks, cancelToken: { cancelled: boolean },
): Promise<void> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
  cb.onFile(idx, { status: "uploading" });

  const { data: created } = await api.post<{ upload_id: string }>(
    "/studies/import/uploads",
    { job_id: jobId, name: file.name, size: file.size, sha256, total_chunks: totalChunks },
  );
  const uploadId = created.upload_id;

  const { data: status } = await api.get<{ received_chunks: number[] }>(
    `/studies/import/uploads/${uploadId}`,
  );
  const have = new Set(status.received_chunks);
  const need: number[] = [];
  for (let i = 0; i < totalChunks; i++) if (!have.has(i)) need.push(i);
  let sent = Math.min(have.size * CHUNK_SIZE, file.size);
  cb.onFile(idx, { bytes_sent: sent });

  const sendOne = async (chunkIdx: number) => {
    if (cancelToken.cancelled) return;
    const start = chunkIdx * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);
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
    cb.onFile(idx, { bytes_sent: Math.min(sent, file.size) });
  };

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

  if (cancelToken.cancelled) {
    cb.onFile(idx, { status: "error", error: "cancelled" });
    return;
  }

  cb.onFile(idx, { status: "finalizing" });
  await api.post("/studies/import/finalize", { upload_id: uploadId });
  cb.onFile(idx, { status: "done" });
}

export async function runUpload({ files, jobId, callbacks, cancelToken }: RunArgs): Promise<void> {
  if (files.length === 0) return;

  // Phase 1: hash all files sequentially to bound memory.
  const hashes: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (cancelToken.cancelled) { callbacks.onCancelled?.(); return; }
    callbacks.onFile(i, { status: "hashing" });
    hashes.push(await sha256OfFile(files[i]));
  }

  // Phase 2: precheck all in one round-trip.
  if (cancelToken.cancelled) { callbacks.onCancelled?.(); return; }
  files.forEach((_, i) => callbacks.onFile(i, { status: "checking" }));
  const { data: pre } = await api.post<{
    results: Record<string, { action: string; instance_count: number; study_ids: string[] }>;
  }>("/studies/import/precheck", {
    files: files.map((f, i) => ({ name: f.name, size: f.size, sha256: hashes[i] })),
  });

  // Mark skipped immediately.
  files.forEach((_f, i) => {
    const r = pre.results[hashes[i]];
    if (r?.action === "skip") {
      callbacks.onFile(i, {
        status: "skipped",
        bytes_sent: files[i].size,
        duplicate_instances: r.instance_count,
      });
    }
  });
  const todo = files.map((f, i) => ({ f, i, sha: hashes[i] }))
    .filter(({ sha }) => pre.results[sha]?.action !== "skip");

  // Phase 3: bounded-parallel uploads.
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < MAX_PARALLEL_FILES; w++) {
    workers.push((async () => {
      while (cursor < todo.length) {
        const my = cursor++;
        if (my >= todo.length) break;
        const { f, i, sha } = todo[my];
        try {
          await uploadOne(f, i, jobId, sha, callbacks, cancelToken);
        } catch (e: unknown) {
          callbacks.onFile(i, {
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })());
  }
  await Promise.all(workers);
  if (cancelToken.cancelled) callbacks.onCancelled?.();
  callbacks.onDone?.();
}

/** Initial empty-progress array helper for callers. */
export function buildInitialProgress(files: File[]): FileProgress[] {
  return files.map((f) => ({
    name: f.name, size: f.size, bytes_sent: 0, status: "pending",
  }));
}
