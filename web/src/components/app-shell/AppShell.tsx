import { type ReactNode } from 'react';
import { shell, sidebarRegion, workspaceRegion } from '../../styles/app-shell.css';
import Sidebar from './Sidebar';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <div className={shell}>
      <aside className={sidebarRegion}>
        <Sidebar />
      </aside>
      <main className={workspaceRegion}>
        {children}
      </main>
    </div>
  );
}
