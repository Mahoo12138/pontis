import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listDeviceOverview,
  revokeDevice,
  registerDevice,
} from '@pontis/api/endpoints/devices';
import type { RegisterDeviceRequest } from '@pontis/api';

export function useDeviceOverview() {
  return useQuery({
    queryKey: ['devices', 'overview'],
    queryFn: () => listDeviceOverview(),
    staleTime: 15_000,
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => revokeDevice(deviceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export function useRegisterDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: RegisterDeviceRequest) => registerDevice(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
