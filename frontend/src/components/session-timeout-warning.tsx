import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Clock } from "lucide-react";

interface SessionTimeoutWarningProps {
  open: boolean;
  secondsRemaining: number;
  onStayLoggedIn: () => void;
  onLogout: () => void;
}

export function SessionTimeoutWarning({ open, secondsRemaining, onStayLoggedIn, onLogout }: SessionTimeoutWarningProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onStayLoggedIn(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" />
            Session Expiring
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Your session will expire in{" "}
          <span className="font-bold text-foreground">{secondsRemaining}</span>{" "}
          seconds due to inactivity.
        </p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onLogout}>Log Out</Button>
          <Button onClick={onStayLoggedIn}>Stay Logged In</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
