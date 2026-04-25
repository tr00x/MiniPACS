import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { AuthProvider } from "@/providers/AuthProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageLoader } from "@/components/PageLoader";
import { AppTransition } from "@/components/AppTransition";

// LoginPage is the entry point — keep it in the main bundle so the first
// render after a cold load doesn't wait on a second chunk.
import { LoginPage } from "@/pages/LoginPage";

// Route-level code splitting: each page is lazy-loaded, so the initial bundle
// only ships the code needed to render the current route. Cuts time-to-first-
// interactive dramatically for users who land on Dashboard and never open the
// settings / audit / transfers admin pages.
const DashboardPage = lazy(() => import("@/pages/DashboardPage").then(m => ({ default: m.DashboardPage })));
const PatientsPage = lazy(() => import("@/pages/PatientsPage").then(m => ({ default: m.PatientsPage })));
const PatientDetailPage = lazy(() => import("@/pages/PatientDetailPage").then(m => ({ default: m.PatientDetailPage })));
const StudiesPage = lazy(() => import("@/pages/StudiesPage").then(m => ({ default: m.StudiesPage })));
const StudyDetailPage = lazy(() => import("@/pages/StudyDetailPage").then(m => ({ default: m.StudyDetailPage })));
const TransfersPage = lazy(() => import("@/pages/TransfersPage").then(m => ({ default: m.TransfersPage })));
const ReceivedPage = lazy(() => import("@/pages/ReceivedPage").then(m => ({ default: m.ReceivedPage })));
const SharesPage = lazy(() => import("@/pages/SharesPage").then(m => ({ default: m.SharesPage })));
const PacsNodesPage = lazy(() => import("@/pages/PacsNodesPage").then(m => ({ default: m.PacsNodesPage })));
const AuditPage = lazy(() => import("@/pages/AuditPage").then(m => ({ default: m.AuditPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const PatientPortalPage = lazy(() => import("@/pages/PatientPortalPage").then(m => ({ default: m.PatientPortalPage })));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage").then(m => ({ default: m.NotFoundPage })));

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <Toaster position="top-right" richColors />
          <AppTransition />
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/patient-portal/:token" element={<PatientPortalPage />} />
              <Route element={<AppLayout />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/patients" element={<PatientsPage />} />
                <Route path="/patients/:id" element={<PatientDetailPage />} />
                <Route path="/studies" element={<StudiesPage />} />
                <Route path="/studies/:id" element={<StudyDetailPage />} />
                <Route path="/transfers" element={<TransfersPage />} />
                <Route path="/received" element={<ReceivedPage />} />
                <Route path="/shares" element={<SharesPage />} />
                <Route path="/pacs-nodes" element={<PacsNodesPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
    </ThemeProvider>
  );
}
