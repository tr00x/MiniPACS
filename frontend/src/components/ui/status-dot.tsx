import { cn } from "@/lib/utils";

type Status = "online" | "offline" | "warning" | "pending";

const STATUS_STYLES: Record<Status, string> = {
  online: "bg-emerald-500",
  offline: "bg-red-500",
  warning: "bg-amber-500",
  pending: "bg-blue-500 animate-pulse",
};

interface StatusDotProps {
  status: Status;
  label?: string;
  className?: string;
}

export function StatusDot({ status, label, className }: StatusDotProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("h-2 w-2 rounded-full", STATUS_STYLES[status])} />
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
    </span>
  );
}
