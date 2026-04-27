import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  LayoutDashboard, Users, ClipboardList, Send, Inbox, Share2,
  Network, Settings, ScrollText, LogOut, ChevronDown, ChevronUp,
  Menu, PanelLeftClose, PanelLeft, Sun, Moon, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const mainNav = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/studies", icon: ClipboardList, label: "Worklist" },
  { to: "/patients", icon: Users, label: "Patients" },
  { to: "/imports", icon: Upload, label: "Imports" },
  { to: "/transfers", icon: Send, label: "Transfers" },
  { to: "/received", icon: Inbox, label: "Received" },
  { to: "/shares", icon: Share2, label: "Shares" },
];

const adminNav = [
  { to: "/pacs-nodes", icon: Network, label: "PACS Nodes" },
  { to: "/audit", icon: ScrollText, label: "Audit Log" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

interface SidebarContentProps {
  collapsed?: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}

function SidebarContent({ collapsed, onNavigate, onToggleCollapse }: SidebarContentProps) {
  const location = useLocation();
  const { logout, user } = useAuth();
  const { theme, setTheme } = useTheme();
  const [adminExpanded, setAdminExpanded] = useState(true);

  const isActive = (to: string) =>
    to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);

  const renderNavItem = ({ to, icon: Icon, label }: (typeof mainNav)[number]) => {
    const btn = (
      <Button
        key={to}
        variant="ghost"
        asChild
        className={cn(
          "w-full gap-2",
          collapsed ? "justify-center px-0" : "justify-start",
          isActive(to) && "bg-accent"
        )}
      >
        <Link to={to} onClick={onNavigate}>
          <Icon className="h-4 w-4 shrink-0" />
          {!collapsed && label}
        </Link>
      </Button>
    );

    if (collapsed) {
      return (
        <Tooltip key={to}>
          <TooltipTrigger asChild>{btn}</TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    }
    return btn;
  };

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full flex-col">
        <div className={cn("flex h-14 items-center border-b", collapsed ? "justify-center px-2" : "justify-between px-4")}>
          {!collapsed && <h1 className="text-lg font-semibold tracking-tight">MiniPACS</h1>}
          {collapsed && <span className="text-lg font-bold">M</span>}
          {onToggleCollapse && !collapsed && (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onToggleCollapse}>
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {collapsed && onToggleCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="w-full" onClick={onToggleCollapse}>
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          )}

          {mainNav.map(renderNavItem)}

          {!collapsed && (
            <button
              onClick={() => setAdminExpanded(!adminExpanded)}
              className="flex w-full items-center justify-between px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>Admin</span>
              {adminExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          )}

          {collapsed && <div className="my-2 mx-2 h-px bg-border" />}

          {(collapsed || adminExpanded) && adminNav.map(renderNavItem)}
        </nav>
        <div className="border-t p-2 space-y-1">
          {!collapsed && <div className="mb-2 px-3 text-xs text-muted-foreground">{user?.username}</div>}
          {!collapsed ? (
            <Button
              variant="ghost"
              className="w-full justify-start gap-2"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="w-full" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                  {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{theme === "dark" ? "Light Mode" : "Dark Mode"}</TooltipContent>
            </Tooltip>
          )}
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="w-full" onClick={() => { onNavigate?.(); logout(); }}>
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Logout</TooltipContent>
            </Tooltip>
          ) : (
            <Button variant="ghost" className="w-full justify-start gap-2" onClick={() => { onNavigate?.(); logout(); }}>
              <LogOut className="h-4 w-4" />
              Logout
            </Button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <aside className={cn(
      "hidden md:flex h-screen flex-col border-r bg-background transition-all duration-200",
      collapsed ? "w-14" : "w-64"
    )}>
      <SidebarContent collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} />
    </aside>
  );
}

export function MobileSidebar() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-0">
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
