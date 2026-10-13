import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMe, getSystemStatus, login, logout, register, resetPassword, setup } from '@pontis/api/endpoints/auth';
import type { LoginRequest, LoginResponse, RegisterRequest, User } from '@pontis/api';
import type { SetupRequest } from '@pontis/api';

export function useMe() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => getMe(),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * The instance's public state, readable with no session. Guards treat a failed
 * read as "unknown" rather than "locked", so an instance whose status endpoint
 * is unreachable can still be logged into.
 */
export function useSystemStatus() {
  return useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => getSystemStatus(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: LoginRequest) => login(params),
    onSuccess: (res) => {
      // Whichever account was cached before, it was not this one. Invalidate
      // would leave `['spaces']` readable inside its staleTime, and `/`
      // redirects into the first space it finds — so a freshly signed-in user
      // landed on the previous account's space.
      qc.clear();
      qc.setQueryData(['auth', 'me'], res.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      // The session ended, so everything cached under it ended with it.
      qc.clear();
    },
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: SetupRequest) => setup(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      // Setup is what flips `initialized`. Left cached for its whole staleTime,
      // the guard would read the pre-setup answer and bounce the visitor back
      // to /setup — a form that has already succeeded.
      qc.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
  });
}

/**
 * Public registration. It creates no session — the server hands back the new
 * account, and the visitor signs in with it — so nothing is invalidated here.
 */
export function useRegister() {
  return useMutation({
    mutationFn: (params: RegisterRequest) => register(params),
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
