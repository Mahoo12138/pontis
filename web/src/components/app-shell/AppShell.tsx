import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  shell,
  sidebarRegion,
  sidebarRegionOpen,
  sidebarBackdrop,
  workspaceRegion,
} from '../../styles/app-shell.css';
import Sidebar from './Sidebar';
import CommandPalette, { OPEN_PALETTE_EVENT } from '../command-palette/CommandPalette';

export const TOGGLE_SIDEBAR_EVENT = 'pontis:toggle-sidebar';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the slide-in sidebar after navigating (it overlays content).
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    const onOpenPalette = () => setPaletteOpen(true);
    const onToggleSidebar = () => setSidebarOpen((v) => !v);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenPalette);
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, onToggleSidebar);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenPalette);
      window.removeEventListener(TOGGLE_SIDEBAR_EVENT, onToggleSidebar);
    };
  }, []);

  return (
    <div className={shell}>
      {sidebarOpen && <div className={sidebarBackdrop} onClick={() => setSidebarOpen(false)} />}
      <aside className={`${sidebarRegion} ${sidebarOpen ? sidebarRegionOpen : ''}`}>
        <Sidebar />
      </aside>
      <main className={workspaceRegion}>
        {children}
      </main>
      <CommandPalette opened={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
