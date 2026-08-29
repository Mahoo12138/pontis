import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppShell from './components/app-shell/AppShell';
import LoginPage from './routes/login';
import SetupPage from './routes/setup';
import SpaceExplorerPage from './routes/space-explorer';
import SpaceActivityPage from './routes/space-activity';
import SpaceOrganizerPage from './routes/space-organizer';
import SearchPage from './routes/search';
import SpacesIndexPage from './routes/spaces-index';
import DevicesPage from './routes/devices';
import PlazaPage from './routes/plaza';
import PlazaDetailPage from './routes/plaza-detail';
import { RequireAuth, RequirePublic } from './features/auth/auth-guard';

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
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/devices" element={<DevicesPage />} />
                  <Route path="/plaza" element={<PlazaPage />} />
                  <Route path="/plaza/:publicationId" element={<PlazaDetailPage />} />
                </Routes>
              </AppShell>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
