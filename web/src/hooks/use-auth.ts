import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { login, logout, getMe } from '@pontis/api/endpoints/auth';
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
