import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Users, FileImage, Send, Share2,
  Network, Settings, ScrollText, LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import api from "@/lib/api";

const nav = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/patients", icon: Users, label: "Patients" },
  { to: "/studies", icon: FileImage, label: "Studies" },
  { to: "/transfers", icon: Send, label: "Transfers" },
  { to: "/shares", icon: Share2, label: "Shares" },
  { to: "/pacs-nodes", icon: Network, label: "PACS Nodes" },
  { to: "/audit", icon: ScrollText, label: "Audit Log" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const location = useLocation();
  const { logout, user } = useAuth();
  const [clinicName, setClinicName] = useState("MiniPACS");

  useEffect(() => {
    api.get("/settings/public").then(({ data }) => {
      if (data.clinic_name) setClinicName(data.clinic_name);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (clinicName !== "MiniPACS") {
      document.title = `${clinicName} Portal`;
    }
  }, [clinicName]);

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <h1 className="text-lg font-semibold tracking-tight">{clinicName}</h1>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {nav.map(({ to, icon: Icon, label }) => (
          <Button
            key={to}
            variant="ghost"
            asChild
            className={cn(
              "w-full justify-start gap-2",
              (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to)) && "bg-accent"
            )}
          >
            <Link to={to}>
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      <div className="border-t p-2">
        <div className="mb-2 px-3 text-xs text-muted-foreground">{user?.username}</div>
        <Button variant="ghost" className="w-full justify-start gap-2" onClick={logout}>
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>
    </aside>
  );
}
