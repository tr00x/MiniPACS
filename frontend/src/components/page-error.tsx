import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageErrorProps {
  message: string;
  onRetry?: () => void;
}

export function PageError({ message, onRetry }: PageErrorProps) {
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
      <div className="flex items-center gap-3">
        <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
        <p className="text-sm text-destructive flex-1">{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
