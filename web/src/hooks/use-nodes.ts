import { useQuery } from '@tanstack/react-query';
import { listNodes, listRootSlots } from '@pontis/api/endpoints/nodes';
import type { NodeListResponse, RootSlotListResponse } from '@pontis/api';

export function useNodes(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'nodes'],
    queryFn: () => listNodes(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}

export function useRootSlots(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'root-slots'],
    queryFn: () => listRootSlots(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}
