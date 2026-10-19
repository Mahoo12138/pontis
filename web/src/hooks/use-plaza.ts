import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listPlazaPublications,
  getPublication,
  publish,
  updatePublication,
  applyPublication,
  unpublish,
} from '@pontis/api/endpoints/plaza';
import type {
  ApplyPublicationRequest,
  PublishRequest,
  UpdatePublicationRequest,
} from '@pontis/api';

export function usePlazaPublications(q: string) {
  return useQuery({
    queryKey: ['plaza', 'publications', q],
    queryFn: () => listPlazaPublications(q || undefined),
    staleTime: 30_000,
  });
}

export function usePublication(id: string | undefined) {
  return useQuery({
    queryKey: ['publications', id],
    queryFn: () => getPublication(id!),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function usePublish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: PublishRequest) => publish(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaza'] });
      qc.invalidateQueries({ queryKey: ['publications'] });
    },
  });
}

export function useUpdatePublication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params }: { id: string; params: UpdatePublicationRequest }) =>
      updatePublication(id, params),
    onSuccess: (detail) => {
      qc.setQueryData(['publications', detail.id], detail);
      qc.invalidateQueries({ queryKey: ['plaza'] });
      qc.invalidateQueries({ queryKey: ['publications'] });
    },
  });
}

export function useApplyPublication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params }: { id: string; params: ApplyPublicationRequest }) =>
      applyPublication(id, params),
    onSuccess: (_res, { params }) => {
      // The explorer caches nodes per space id, so the invalidation has to
      // name that space: a placeholder key matches nothing and the imported
      // nodes stay invisible until the cache goes stale.
      qc.invalidateQueries({ queryKey: ['spaces', params.space_id, 'nodes'] });
    },
  });
}

export function useUnpublish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unpublish(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaza'] });
      qc.invalidateQueries({ queryKey: ['publications'] });
    },
  });
}
