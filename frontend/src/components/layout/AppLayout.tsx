import { Outlet, Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
