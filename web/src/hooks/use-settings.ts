import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createToken,
  getSystemSettings,
  listTokens,
  revokeToken,
  updateProfile,
  updateSystemSettings,
} from '@pontis/api/endpoints/settings';
import type { CreateTokenRequest, SystemSettings } from '@pontis/api';

export function useTokens() {
  return useQuery({
    queryKey: ['tokens'],
    queryFn: () => listTokens(),
    staleTime: 30_000,
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateTokenRequest) => createToken(params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
}

export function useSystemSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => getSystemSettings(),
    staleTime: 30_000,
  });
}

export function useUpdateSystemSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Partial<SystemSettings>) => updateSystemSettings(params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { display_name?: string; email?: string }) => updateProfile(params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
  });
}
