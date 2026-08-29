import { useQuery, useMutation } from '@tanstack/react-query';
import {
  runLinkCheck,
  listLinkCheckResults,
  listDuplicates,
} from '@pontis/api/endpoints/organizer';

export function useLinkCheckRun(spaceId: string | undefined) {
  return useMutation({
    mutationFn: () => runLinkCheck(spaceId!),
  });
}

export function useLinkCheckResults(spaceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'link-check'],
    queryFn: () => listLinkCheckResults(spaceId!),
    enabled: !!spaceId && enabled,
    staleTime: 30_000,
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
