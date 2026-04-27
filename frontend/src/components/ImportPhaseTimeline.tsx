/* 4-step horizontal timeline showing what the import is doing now
 * AND what's coming next, so the radiologist sees the whole arc
 * instead of just a percent.
 *
 * Steps:
 *   1. Hash       — local CPU only, no network
 *   2. Dedup      — single round-trip to ask PACS what it has
 *   3. Upload     — chunked transfer of the not-already-known files
 *   4. Store      — server-side: extract archives, push to PACS
 *
 * Sources:
 *   - Local-side phases (1-3) come from the per-file status array
 *     emitted by the chunked-upload pipeline (ImportsProvider slice).
 *   - Server-side phase (4) comes from the backend's job.status
 *     field (extracting / uploading / done / error / cancelled).
 */
import { CheckCircle2, Loader2, Circle, AlertCircle, XCircle } from "lucide-react";
import type { LocalUploadState } from "@/providers/ImportsProvider";
import type { ImportJobStatus } from "@/hooks/useImportJob";

type Phase = "hash" | "dedup" | "upload" | "store";
type State = "pending" | "active" | "done" | "error" | "cancelled";

const PHASE_LABELS: Record<Phase, { title: string; description: string }> = {
  hash: { title: "Hash files", description: "Local SHA-256 — no network" },
  dedup: { title: "Check duplicates", description: "Ask PACS what it already has" },
  upload: { title: "Upload chunks", description: "5 MB chunks, auto-resume" },
  store: { title: "Store in PACS", description: "Extract archives, write to PACS" },
};

interface Props {
  job: ImportJobStatus;
  local?: LocalUploadState;
}

export function ImportPhaseTimeline({ job, local }: Props) {
  const phaseStates = computePhaseStates(job, local);
  return (
    <div className="border rounded-md p-3 space-y-2 bg-muted/20">
      <div className="text-xs font-medium text-muted-foreground">Pipeline</div>
      <ol className="grid grid-cols-4 gap-2">
        {(Object.keys(PHASE_LABELS) as Phase[]).map((p, idx) => (
          <PhaseStep key={p} phase={p} state={phaseStates[p]} step={idx + 1} />
        ))}
      </ol>
    </div>
  );
}

function PhaseStep({ phase, state, step }: { phase: Phase; state: State; step: number }) {
  const { title, description } = PHASE_LABELS[phase];
  const Icon =
    state === "done" ? CheckCircle2
    : state === "active" ? Loader2
    : state === "error" ? XCircle
    : state === "cancelled" ? AlertCircle
    : Circle;
  const tone =
    state === "done" ? "text-emerald-600 dark:text-emerald-400"
    : state === "active" ? "text-primary"
    : state === "error" ? "text-destructive"
    : state === "cancelled" ? "text-muted-foreground"
    : "text-muted-foreground/60";

  return (
    <li className="flex flex-col gap-1">
      <div className={`flex items-center gap-1.5 text-xs font-medium ${tone}`}>
        <Icon className={`h-4 w-4 shrink-0 ${state === "active" ? "animate-spin" : ""}`} />
        <span className="text-[10px] tabular-nums opacity-60">{step}.</span>
        <span className="truncate">{title}</span>
      </div>
      <div className="text-[10px] text-muted-foreground leading-snug pl-5">
        {description}
      </div>
    </li>
  );
}

function computePhaseStates(
  job: ImportJobStatus,
  local: LocalUploadState | undefined,
): Record<Phase, State> {
  // Terminal-job overrides: paint done/error/cancelled across phases
  // appropriately so the user reads a coherent end-state.
  if (job.status === "cancelled") {
    return phaseFill("cancelled", phaseProgress(job, local));
  }
  if (job.status === "error") {
    return phaseFill("error", phaseProgress(job, local));
  }
  if (job.status === "done") {
    return { hash: "done", dedup: "done", upload: "done", store: "done" };
  }

  // Live phases — figure out what's actively running.
  const active = activePhase(job, local);
  return {
    hash:   active === "hash"   ? "active" : phaseDone("hash",   active) ? "done" : "pending",
    dedup:  active === "dedup"  ? "active" : phaseDone("dedup",  active) ? "done" : "pending",
    upload: active === "upload" ? "active" : phaseDone("upload", active) ? "done" : "pending",
    store:  active === "store"  ? "active" : phaseDone("store",  active) ? "done" : "pending",
  };
}

const PHASE_ORDER: Phase[] = ["hash", "dedup", "upload", "store"];

function phaseDone(p: Phase, currentlyActive: Phase | null): boolean {
  if (!currentlyActive) return false;
  return PHASE_ORDER.indexOf(p) < PHASE_ORDER.indexOf(currentlyActive);
}

function activePhase(job: ImportJobStatus, local: LocalUploadState | undefined): Phase | null {
  // Server-side phases trump local ones — once the backend says
  // 'extracting' we know upload is done.
  if (job.status === "extracting" || job.status === "uploading") return "store";

  if (local && local.files.length > 0) {
    if (local.files.some((f) => f.status === "hashing")) return "hash";
    if (local.files.some((f) => f.status === "checking")) return "dedup";
    if (local.files.some((f) => f.status === "uploading" || f.status === "finalizing")) return "upload";
    // All local files are terminal (done/skipped/error) — server is
    // either already running (caught above) or about to start.
    if (local.files.every((f) => ["done", "skipped", "error"].includes(f.status))) return "store";
  }

  // Attached to a remote job we didn't start ourselves — best
  // approximation from server progress.
  if (job.status === "queued") return "upload"; // chunks flowing in, server hasn't started processing
  return null;
}

function phaseProgress(job: ImportJobStatus, local: LocalUploadState | undefined): Phase {
  // Where we got to before terminal — used to render done up to that
  // point and the failed/cancelled icon on the offending phase.
  return activePhase(job, local) || "store";
}

function phaseFill(end: State, upTo: Phase): Record<Phase, State> {
  const idx = PHASE_ORDER.indexOf(upTo);
  return {
    hash: PHASE_ORDER.indexOf("hash") < idx ? "done" : end,
    dedup: PHASE_ORDER.indexOf("dedup") < idx ? "done" : end,
    upload: PHASE_ORDER.indexOf("upload") < idx ? "done" : end,
    store: PHASE_ORDER.indexOf("store") < idx ? "done" : end,
  };
}
