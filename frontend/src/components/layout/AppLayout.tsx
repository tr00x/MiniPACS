import { useEffect, useState } from "react";
import { Outlet, Navigate } from "react-router-dom";
import { motion } from "motion/react";
import { useAuth } from "@/lib/auth";
import { Sidebar, MobileSidebar } from "./Sidebar";
import { ImportIndicator } from "@/components/ImportIndicator";
import { ImportDialog } from "@/components/ImportDialog";
import { useGlobalFileDrop } from "@/hooks/useGlobalFileDrop";
import { useActiveImports } from "@/hooks/useActiveImports";
import { useImports } from "@/providers/ImportsProvider";

export function AppLayout() {
  const { isAuthenticated } = useAuth();
  const drop = useGlobalFileDrop();
  const imports = useImports();
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  // Single poller for both indicator slots (mobile topbar + desktop main).
  // Mounting <ImportIndicator/> twice with its own hook would double the
  // /active polling rate.
  const activeJobs = useActiveImports();

  // Window drop → start a fresh import via the global manager. Each drop
  // gets its own job_id, so dragging in a second batch while the first
  // is still uploading no longer overwrites the in-flight one (the bug
  // that made multi-disc CD imports lose progress).
  useEffect(() => {
    if (!drop.pending) return;
    const files = drop.take();
    if (!files || files.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const jobId = await imports.start(files);
        if (!cancelled && !openJobId) {
          // Auto-open the viewer for the *first* concurrent import so
          // the user gets immediate visual feedback. Subsequent drops
          // run silently — pill counter shows them.
          setOpenJobId(jobId);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // toast already inside provider when start succeeds; surface
        // the rare start-job failure directly here.
        // eslint-disable-next-line no-console
        console.error("import start failed", msg);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drop.pending]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-screen flex-col md:flex-row relative"
    >
      {/* Mobile top bar */}
      <div className="flex h-14 items-center border-b px-4 md:hidden">
        <MobileSidebar />
        <h1 className="ml-2 text-lg font-semibold">MiniPACS</h1>
        <div className="ml-auto"><ImportIndicator jobs={activeJobs} onOpen={setOpenJobId} /></div>
      </div>
      <Sidebar />
      <main className="flex-1 overflow-auto p-4 md:p-6">
        <div className="hidden md:flex justify-end mb-2">
          <ImportIndicator jobs={activeJobs} onOpen={setOpenJobId} />
        </div>
        <Outlet />
      </main>

      {/* Window-level drop overlay */}
      {drop.dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 border-4 border-dashed border-primary/40">
          <div className="text-2xl font-semibold text-primary bg-background/80 rounded-lg px-6 py-4 shadow-lg">
            Drop files anywhere to import
          </div>
        </div>
      )}

      {/* Single live-view dialog. The pill (ImportIndicator) lets the
           user switch between concurrent imports — each click sets
           openJobId, so the same dialog instance re-attaches to the
           selected job. Closing keeps every upload running. */}
      {openJobId && (
        <ImportDialog
          open={true}
          onOpenChange={(o) => { if (!o) setOpenJobId(null); }}
          attachJobId={openJobId}
        />
      )}
    </motion.div>
  );
}
