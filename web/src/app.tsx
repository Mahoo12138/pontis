import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppShell from './components/app-shell/AppShell';
import LoginPage from './routes/login';
import SetupPage from './routes/setup';
import SpaceExplorerPage from './routes/space-explorer';
import SpacesIndexPage from './routes/spaces-index';
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
                </Routes>
              </AppShell>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
