import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Center, Loader } from '@mantine/core';
import { useMe } from '../../hooks/use-auth';

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
 * Gate for public pages (login/setup): an already-authenticated user is
 * sent straight into the app instead of seeing the form again.
 */
export function RequirePublic({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe();

  if (isLoading) return <FullScreenLoader />;
  if (data) return <Navigate to="/" replace />;
  return <>{children}</>;
}
