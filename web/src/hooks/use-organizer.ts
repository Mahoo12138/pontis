import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  runLinkCheck,
  listLinkCheckResults,
  deleteBrokenLinks,
  listDuplicates,
} from '@pontis/api/endpoints/organizer';

export function useLinkCheckRun(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runLinkCheck(spaceId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'link-check'] });
    },
  });
}

export function useDeleteBrokenLinks(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { job_id: string; node_ids: string[] }) =>
      deleteBrokenLinks(spaceId!, params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'link-check'] });
    },
  });
}

export function useLinkCheckResults(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'link-check'],
    queryFn: () => listLinkCheckResults(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
    // The run is server-side work: until every bookmark has an answer, the
    // page follows it. Without this the panel keeps whatever it read the
    // moment after enqueueing, and the findings never arrive.
    refetchInterval: (query) => {
      const run = query.state.data;
      return run && run.done < run.total ? 2_000 : false;
    },
  });
}

export function useDuplicates(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'duplicates'],
    queryFn: () => listDuplicates(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}
