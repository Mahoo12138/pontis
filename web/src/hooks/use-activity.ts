import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listActivity, undoActivity } from '@pontis/api/endpoints/activity';

export function useActivity(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'activity'],
    queryFn: () => listActivity(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}

/**
 * Undo one ChangeSet through the server-side undo endpoint. Success
 * invalidates the activity feed and node tree; error mapping (review
 * required / expired / not undoable) stays in the page component.
 */
export function useUndoActivity(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ changeSetId }: { changeSetId: string }) =>
      undoActivity(spaceId!, changeSetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'activity'] });
      qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'nodes'] });
    },
  });
}
