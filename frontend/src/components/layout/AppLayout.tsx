import { Outlet, Navigate } from "react-router-dom";
import { motion } from "motion/react";
import { useAuth } from "@/lib/auth";
import { Sidebar, MobileSidebar } from "./Sidebar";

export function AppLayout() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
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
