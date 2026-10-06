import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/app-shell/AppShell';
import LoginPage from './routes/login';
import SetupPage from './routes/setup';
import SpaceExplorerPage from './routes/space-explorer';
import SpaceActivityPage from './routes/space-activity';
import SpaceOrganizerPage from './routes/space-organizer';
import SpaceBackupsPage from './routes/space-backups';
import SearchPage from './routes/search';
import TasksPage from './routes/tasks';
import SpacesIndexPage from './routes/spaces-index';
import DevicesPage from './routes/devices';
import PlazaPage from './routes/plaza';
import PlazaDetailPage from './routes/plaza-detail';
import SettingsLayout, {
  AccountPanel as SettingsAccountPage,
  PreferencesPanel as SettingsPreferencesPage,
  TokensPanel as SettingsApiTokensPage,
} from './routes/settings';
import AdminLayout from './routes/admin';
import AdminUsersPage from './routes/admin-users';
import JobsPage from './routes/jobs';
import AdminSystemPage from './routes/admin-system';
import { RequireAuth, RequirePublic, RequireAdmin } from './features/auth/auth-guard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            <RequirePublic>
              <LoginPage />
            </RequirePublic>
          }
        />
        <Route
          path="/setup"
          element={
            <RequirePublic>
              <SetupPage />
            </RequirePublic>
          }
        />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <AppShell>
                <Routes>
                  <Route path="/" element={<SpacesIndexPage />} />
                  <Route path="/spaces/:spaceId" element={<SpaceExplorerPage />} />
                  <Route path="/spaces/:spaceId/activity" element={<SpaceActivityPage />} />
                  <Route path="/spaces/:spaceId/organizer" element={<SpaceOrganizerPage />} />
                  <Route path="/spaces/:spaceId/backups" element={<SpaceBackupsPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/devices" element={<DevicesPage />} />
                  <Route path="/plaza" element={<PlazaPage />} />
                  <Route path="/plaza/:publicationId" element={<PlazaDetailPage />} />
                  <Route path="/settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="/settings/account" replace />} />
                    <Route path="account" element={<SettingsAccountPage />} />
                    <Route path="preferences" element={<SettingsPreferencesPage />} />
                    <Route path="api-tokens" element={<SettingsApiTokensPage />} />
                  </Route>
                  <Route
                    path="/admin"
                    element={
                      <RequireAdmin>
                        <AdminLayout />
                      </RequireAdmin>
                    }
                  >
                    <Route index element={<Navigate to="/admin/users" replace />} />
                    <Route path="users" element={<AdminUsersPage />} />
                    <Route path="jobs" element={<JobsPage />} />
                    <Route path="system" element={<AdminSystemPage />} />
                  </Route>
                </Routes>
              </AppShell>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
