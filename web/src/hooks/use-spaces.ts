import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listSpaces, createSpace, renameSpace, deleteSpace } from '@pontis/api/endpoints/spaces';
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
      qc.invalidateQueries({ queryKey: ['spaces'], exact: true });
    },
  });
}

export function useRenameSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameSpace(id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaces'], exact: true });
    },
  });
}

/**
 * Deleting is refused for a space that still has content (409 SPACE_NOT_EMPTY),
 * so the caller surfaces the server's reason instead of retrying a cascade the
 * server will not perform.
 *
 * The cache is left to the caller on purpose: invalidating here refetches the
 * explorer of the space that has just ceased to exist, because the route is
 * still mounted when the mutation lands. Callers navigate first, then refresh.
 */
export function useDeleteSpace() {
  return useMutation({
    mutationFn: (id: string) => deleteSpace(id),
  });
}
