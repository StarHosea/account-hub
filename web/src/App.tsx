import { Routes, Route, Navigate } from "react-router-dom";

import AppLayout from "@/layouts/AppLayout";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";
import ActivatorPage from "@/pages/ActivatorPage";
import AccountsPage from "@/pages/AccountsPage";
import CdksPage from "@/pages/CdksPage";
import MailboxesPage from "@/pages/MailboxesPage";
import PhonesPage from "@/pages/PhonesPage";
import DispatchPage from "@/pages/DispatchPage";
import ActivationAuditPage from "@/pages/ActivationAuditPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/register" replace />} />
        {/* 旧工作台/仪表盘统一并入注册机 */}
        <Route path="/dashboard" element={<Navigate to="/register" replace />} />
        <Route path="/workbench" element={<Navigate to="/register" replace />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/activator" element={<ActivatorPage />} />
        <Route path="/accounts/free" element={<AccountsPage planType="free" />} />
        <Route path="/accounts/plus" element={<AccountsPage planType="plus" />} />
        <Route path="/accounts" element={<Navigate to="/accounts/free" replace />} />
        <Route path="/mailboxes" element={<MailboxesPage />} />
        <Route path="/cdks" element={<CdksPage />} />
        <Route path="/phones" element={<PhonesPage />} />
        <Route path="/dispatch" element={<DispatchPage />} />
        <Route path="/activation-audit" element={<ActivationAuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
