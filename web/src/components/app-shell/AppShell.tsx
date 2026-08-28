import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { shell, sidebarRegion, workspaceRegion } from '../../styles/app-shell.css';
import Sidebar from './Sidebar';
import CommandPalette, { OPEN_PALETTE_EVENT } from '../command-palette/CommandPalette';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    const onOpenPalette = () => setPaletteOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenPalette);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenPalette);
    };
  }, []);

  return (
    <div className={shell}>
      <aside className={sidebarRegion}>
        <Sidebar />
      </aside>
      <main className={workspaceRegion}>
        {children}
      </main>
      <CommandPalette opened={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
