import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createResetLink,
  listAdminUsers,
  setUserRole,
  setUserStatus,
} from '@pontis/api/endpoints/admin-users';

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => listAdminUsers(),
    staleTime: 15_000,
  });
}

export function useSetUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: 'active' | 'disabled' }) =>
      setUserStatus(userId, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}

export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'user' }) =>
      setUserRole(userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}

export function useCreateResetLink() {
  return useMutation({
    mutationFn: (userId: string) => createResetLink(userId),
  });
}
