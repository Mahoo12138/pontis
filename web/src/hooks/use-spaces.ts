import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listSpaces, createSpace } from '@pontis/api/endpoints/spaces';
import type { SpaceListResponse, CreateSpaceRequest } from '@pontis/api';

export function useSpaces() {
  return useQuery({
    queryKey: ['spaces'],
    queryFn: () => listSpaces(),
    staleTime: 30_000,
  });
}

export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateSpaceRequest) => createSpace(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}
