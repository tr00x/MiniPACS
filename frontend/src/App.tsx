import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/providers/AuthProvider";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { PatientsPage } from "@/pages/PatientsPage";
import { PatientDetailPage } from "@/pages/PatientDetailPage";
import { StudiesPage } from "@/pages/StudiesPage";
import { StudyDetailPage } from "@/pages/StudyDetailPage";
import { TransfersPage } from "@/pages/TransfersPage";
import { SharesPage } from "@/pages/SharesPage";
import { PacsNodesPage } from "@/pages/PacsNodesPage";
import { AuditPage } from "@/pages/AuditPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { PatientPortalPage } from "@/pages/PatientPortalPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
            <Route path="/shares" element={<SharesPage />} />
            <Route path="/pacs-nodes" element={<PacsNodesPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
