import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getPlazaFacets,
  listPlazaPublications,
  getPublication,
  listPublicationVersions,
  publish,
  updatePublication,
  applyPublication,
  unpublish,
} from '@pontis/api/endpoints/plaza';
import type {
  ApplyPublicationRequest,
  PlazaSearchParams,
  PublishRequest,
  UpdatePublicationRequest,
} from '@pontis/api';

export const PLAZA_PAGE_SIZE = 12;

/**
 * The plaza index, paged. Filters live in the query key so a searched and
 * filtered list is one the user can bookmark and come back to.
 */
export function usePlazaPublications(params: PlazaSearchParams) {
  return useInfiniteQuery({
    queryKey: ['plaza', 'publications', params],
    queryFn: ({ pageParam }) =>
      listPlazaPublications({
        ...params,
        limit: PLAZA_PAGE_SIZE,
        offset: pageParam as number,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const seen = pages.reduce((n, p) => n + p.publications.length, 0);
      return seen < lastPage.total ? seen : undefined;
    },
    staleTime: 30_000,
  });
}

export function usePlazaFacets() {
  return useQuery({
    queryKey: ['plaza', 'facets'],
    queryFn: getPlazaFacets,
    staleTime: 60_000,
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

export function usePublicationVersions(id: string | undefined) {
  return useQuery({
    queryKey: ['publications', id, 'versions'],
    queryFn: () => listPublicationVersions(id!),
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
    onSuccess: (_res, { id, params }) => {
      // The explorer caches nodes per space id, so the invalidation has to
      // name that space: a placeholder key matches nothing and the imported
      // nodes stay invisible until the cache goes stale.
      qc.invalidateQueries({ queryKey: ['spaces', params.space_id, 'nodes'] });
      // The detail page also carries the viewer's own import state; without
      // this it keeps offering "update to vN" after the update succeeded.
      qc.invalidateQueries({ queryKey: ['publications', id] });
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
