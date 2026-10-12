import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { login, logout, getMe, resetPassword } from '@pontis/api/endpoints/auth';
import type { LoginRequest, LoginResponse, User } from '@pontis/api';
import type { SetupRequest } from '@pontis/api';
import { setup } from '@pontis/api/endpoints/auth';

export function useMe() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => getMe(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: LoginRequest) => login(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      qc.setQueryData(['auth', 'me'], null);
      qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: SetupRequest) => setup(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { token: string; new_password: string }) => resetPassword(params),
    onSuccess: () => {
      // The server dropped every session of that user when it took the new
      // password, so any cached identity is stale — and the token has been
      // spent either way, so a retry must not look available.
      qc.setQueryData(['auth', 'me'], null);
      qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}
