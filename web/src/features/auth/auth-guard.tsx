import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Center, Loader } from '@mantine/core';
import { useMe, useSystemStatus } from '../../hooks/use-auth';

const SETUP_PATH = '/setup';

function FullScreenLoader() {
  return (
    <Center h="100vh">
      <Loader size="sm" />
    </Center>
  );
}

/**
 * Gate for authenticated routes: queries GET /auth/me once (cached 60s);
 * unauthenticated visitors are sent to /login.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading, isError } = useMe();

  if (isLoading) return <FullScreenLoader />;
  if (isError || !data) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Gate for admin-only routes (/admin/*): non-admin users are sent back
 * to the home page. Admin pages keep their own first-class navigation.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data, isLoading, isError } = useMe();

  if (isLoading) return <FullScreenLoader />;
  if (isError || !data) return <Navigate to="/login" replace />;
  if (data.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Gate for the session-less pages (login / register / setup / reset). Two
 * redirects, both so a visitor lands on the page that can actually take them:
 *
 * - an instance with no admin yet has nobody to log in as, so every public page
 *   but /setup points at /setup;
 * - /setup itself is a one-shot bootstrap form, and the server refuses it once
 *   an admin exists, so an initialized instance is sent back to /login.
 *
 * A status read that fails (or has not resolved yet) gets no opinion at all:
 * both pages stay reachable. Otherwise a broken /system/status would cost the
 * one thing it exists to protect — a fresh instance's way in.
 */
export function RequirePublic({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  const { data: status } = useSystemStatus();
  const { pathname } = useLocation();

  if (isLoading) return <FullScreenLoader />;
  if (me) return <Navigate to="/" replace />;

  const onSetup = pathname === SETUP_PATH;
  if (status?.initialized && onSetup) return <Navigate to="/login" replace />;
  if (status && !status.initialized && !onSetup) return <Navigate to={SETUP_PATH} replace />;
  return <>{children}</>;
}
