import { useEffect, useRef } from "react";
import { Outlet, Navigate } from "react-router-dom";
import { motion } from "motion/react";
import { useAuth } from "@/lib/auth";
import { Sidebar, MobileSidebar } from "./Sidebar";

export function AppLayout() {
  const { isAuthenticated } = useAuth();
  // First mount after login = scale-in entrance under the flash. Subsequent
  // mounts (e.g. user manually refreshes /studies) skip the entrance so the
  // page snaps in normally.
  const firstRender = useRef(true);
  useEffect(() => { firstRender.current = false; }, []);
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <motion.div
      initial={firstRender.current ? { opacity: 0, scale: 0.96 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-screen flex-col md:flex-row"
    >
      {/* Mobile top bar */}
      <div className="flex h-14 items-center border-b px-4 md:hidden">
        <MobileSidebar />
        <h1 className="ml-2 text-lg font-semibold">MiniPACS</h1>
      </div>
      {/* Desktop sidebar */}
      <Sidebar />
      <main className="flex-1 overflow-auto p-4 md:p-6">
        <Outlet />
      </main>
    </motion.div>
  );
}
