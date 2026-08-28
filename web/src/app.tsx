import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppShell from './components/app-shell/AppShell';
import LoginPage from './routes/login';
import SetupPage from './routes/setup';
import SpaceExplorerPage from './routes/space-explorer';
import SpacesIndexPage from './routes/spaces-index';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route
          path="/*"
          element={
            <AppShell>
              <Routes>
                <Route path="/" element={<SpacesIndexPage />} />
                <Route path="/spaces/:spaceId" element={<SpaceExplorerPage />} />
              </Routes>
            </AppShell>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
