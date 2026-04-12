import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Users, ClipboardList, Send, Share2,
  Network, Settings, ScrollText, LogOut, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const mainNav = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/studies", icon: ClipboardList, label: "Worklist" },
  { to: "/patients", icon: Users, label: "Patients" },
  { to: "/transfers", icon: Send, label: "Transfers" },
  { to: "/shares", icon: Share2, label: "Shares" },
];

const adminNav = [
  { to: "/pacs-nodes", icon: Network, label: "PACS Nodes" },
  { to: "/audit", icon: ScrollText, label: "Audit Log" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const location = useLocation();
  const { logout, user } = useAuth();
  const [adminExpanded, setAdminExpanded] = useState(true);

  const isActive = (to: string) =>
    to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);

  const renderNavItem = ({ to, icon: Icon, label }: (typeof mainNav)[number]) => (
    <Button
      key={to}
      variant="ghost"
      asChild
      className={cn(
        "w-full justify-start gap-2",
        isActive(to) && "bg-accent"
      )}
    >
      <Link to={to}>
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    </Button>
  );

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <h1 className="text-lg font-semibold tracking-tight">MiniPACS</h1>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {mainNav.map(renderNavItem)}

        <button
          onClick={() => setAdminExpanded(!adminExpanded)}
          className="flex w-full items-center justify-between px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>Admin</span>
          {adminExpanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>

        {adminExpanded && adminNav.map(renderNavItem)}
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
