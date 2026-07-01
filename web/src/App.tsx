import { Routes, Route, Navigate } from "react-router-dom";

import AppLayout from "@/layouts/AppLayout";
import LoginPage from "@/pages/LoginPage";
import AccountsPage from "@/pages/AccountsPage";
import CdksPage from "@/pages/CdksPage";
import MailboxesPage from "@/pages/MailboxesPage";
import PhonesPage from "@/pages/PhonesPage";
import DispatchPage from "@/pages/DispatchPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/accounts" replace />} />
        <Route path="/dashboard" element={<Navigate to="/accounts" replace />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/cdks" element={<CdksPage />} />
        <Route path="/phones" element={<PhonesPage />} />
        <Route path="/dispatch" element={<DispatchPage />} />
        <Route path="/mailboxes" element={<MailboxesPage />} />
        <Route path="/register" element={<Navigate to="/settings" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
