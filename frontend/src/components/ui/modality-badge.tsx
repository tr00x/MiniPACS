import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const MODALITY_COLORS: Record<string, string> = {
  CT: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  MR: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200",
  CR: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  DX: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  US: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  NM: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
  PT: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
  XA: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  MG: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-200",
  RF: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
  OT: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
};

const DEFAULT_COLOR = "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

interface ModalityBadgeProps {
  modality: string;
  className?: string;
}

export function ModalityBadge({ modality, className }: ModalityBadgeProps) {
  const color = MODALITY_COLORS[modality] || DEFAULT_COLOR;
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded px-1.5 py-0 text-[11px] font-semibold border-0 uppercase tracking-wide",
        color,
        className
      )}
    >
      {modality}
    </Badge>
  );
}

export function ModalityBadgeList({ modalities, className }: { modalities: string[]; className?: string }) {
  if (!modalities?.length) return null;
  return (
    <div className={cn("flex gap-1 flex-wrap", className)}>
      {modalities.map((m) => (
        <ModalityBadge key={m} modality={m} />
      ))}
    </div>
  );
}
